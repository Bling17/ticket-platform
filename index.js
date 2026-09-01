const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const redis = require('redis');
const cors = require('cors');
require('dotenv').config();
const nodemailer = require('nodemailer');

// ==========================================
// EMAIL SETUP
// ==========================================
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==========================================
// POSTGRESQL & REDIS CONNECTIONS
// ==========================================
const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:mysecretpassword@localhost:5432/postgres',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pgPool.on('connect', () => {
    console.log('✅ Connected to PostgreSQL Database');
});

const redisClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.log('Redis Error:', err));

// ==========================================
// TICKETMASTER SEARCH & LIVE FETCH
// ==========================================
app.get('/api/search', async (req, res) => {
    try {
        const keyword = req.query.keyword;
        const searchTerm = keyword ? keyword : 'Music';
        const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${process.env.TICKETMASTER_API_KEY}&keyword=${encodeURIComponent(searchTerm)}`;
        
        console.log("Fetching from URL:", url);
        const response = await fetch(url);
        const data = await response.json();
        console.log("Ticketmaster API Response Status:", response.status);
        console.log("Ticketmaster Data Received:", JSON.stringify(data).substring(0, 200)); // Print first 200 chars

        if (!response.ok || !data._embedded || !data._embedded.events || data._embedded.events.length === 0) {
            return res.status(404).json({ error: 'No live events found for this search.', details: data });
        }

        // Rest of your insertion loop remains here...

        // Drop constraints and delete SEATS BEFORE EVENTS
        await pgPool.query(`ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_event_id_fkey;`);
        await pgPool.query(`ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_seat_id_fkey;`);
        await pgPool.query(`DELETE FROM seats;`);
        await pgPool.query(`DELETE FROM events;`);

        const liveEvents = data._embedded.events;
        let insertedCount = 0;

        for (let event of liveEvents) {
            const title = event.name;
            const date = `${event.dates.start.localDate} • ${event.dates.start.localTime || 'TBA'}`;
            const venue = event._embedded.venues ? event._embedded.venues[0].name : 'Venue TBA';
            const image_url = event.images.find(img => img.ratio === '16_9')?.url || event.images[0].url;

            await pgPool.query(`
                INSERT INTO events (title, date, venue, image_url)
                VALUES ($1, $2, $3, $4)
            `, [title, date, venue, image_url]);
            
            insertedCount++;
        }

        res.json({ message: 'Success', count: insertedCount });
    } catch (err) {
        console.error('Search Error:', err);
        res.status(500).json({ error: 'Server error while fetching from Ticketmaster.' });
    }
});

// ==========================================
// EVENTS & SEATS ROUTES
// ==========================================
app.get('/api/events', async (req, res) => {
    try {
        const { rows } = await pgPool.query('SELECT * FROM events ORDER BY id ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/generate-seats', async (req, res) => {
    try {
        await pgPool.query(`ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_seat_id_fkey;`);
        await pgPool.query(`
            DROP TABLE IF EXISTS seats CASCADE;
            CREATE TABLE seats (
                id SERIAL PRIMARY KEY,
                event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
                section VARCHAR(50),
                row VARCHAR(50),
                seat_number INTEGER,
                price INTEGER,
                status VARCHAR(50) DEFAULT 'available'
            );
        `);

        const { rows: events } = await pgPool.query('SELECT id FROM events');
        
        let insertCount = 0;
        for (let event of events) {
            for (let r = 1; r <= 3; r++) {
                for (let s = 1; s <= 5; s++) {
                    await pgPool.query(`
                        INSERT INTO seats (event_id, section, row, seat_number, price, status)
                        VALUES ($1, 'VIP', $2, $3, 150000, 'available')
                    `, [event.id, `Row ${r}`, s]);
                    insertCount++;
                }
            }
        }
        res.send(`💺 Generated ${insertCount} interactive seats!`);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/events/:eventId/seats', async (req, res) => {
    try {
        const { rows } = await pgPool.query(
            'SELECT * FROM seats WHERE event_id = $1 ORDER BY row, seat_number', 
            [req.params.eventId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ==========================================
// TICKET TRANSFER ENGINE (Email & Database)
// ==========================================

// 1. Setup Tickets Table & Mint a Test Ticket
app.get('/api/setup-tickets', async (req, res) => {
    try {
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS tickets (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255),
                price INTEGER DEFAULT 150000,
                status VARCHAR(50) DEFAULT 'owned',
                transfer_token VARCHAR(255),
                transfer_recipient_email VARCHAR(255),
                transfer_status VARCHAR(50) DEFAULT 'none'
            );
            
            INSERT INTO tickets (id, user_id, price, status) 
            VALUES (1, 'user_joshua_123', 150000, 'owned')
            ON CONFLICT (id) DO UPDATE 
            SET user_id = 'user_joshua_123', price = 150000, status = 'owned', transfer_status = 'none', transfer_token = NULL;
        `);
        res.send('🎟️ Tickets table created and Test Ticket #1 minted!');
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// 2. Transfer Route (Sends the Real Email)
app.post('/api/tickets/transfer', async (req, res) => {
    try {
        // NEW: We receive the custom event_name and seat_info from the frontend
        const { ticket_id, owner_id, recipient_email, event_name, seat_info } = req.body;
        const transferToken = crypto.randomBytes(20).toString('hex'); 

        const result = await pgPool.query(`
            UPDATE tickets 
            SET transfer_token = $1, transfer_recipient_email = $2, transfer_status = 'pending' 
            WHERE id = $3 RETURNING *;
        `, [transferToken, recipient_email, ticket_id]);

        if (result.rows.length === 0) return res.status(400).json({ error: 'Ticket not found.' });

        const acceptLink = `http://localhost:5000/api/tickets/accept?token=${transferToken}`;

        const mailOptions = {
            from: '"MyuzeTix Platform" <' + process.env.EMAIL_USER + '>',
            to: recipient_email,
            subject: `🎟️ ${owner_id} sent you a ticket to ${event_name}!`,
            html: `
                <div style="background: #121212; color: white; padding: 40px; font-family: sans-serif; text-align: center; border-radius: 8px;">
                    <h2 style="color: #026cdf; margin-bottom: 30px;">${owner_id} has transferred a ticket to you!</h2>
                    
                    <div style="background: #1a1a1f; padding: 25px; border-radius: 8px; margin-bottom: 30px; border-left: 4px solid #4CAF50; text-align: left; display: inline-block; min-width: 300px;">
                        <h3 style="margin-top: 0; color: white;">${event_name}</h3>
                        <p style="color: #ccc; font-size: 16px; margin-bottom: 5px;"><strong>Seat Info:</strong> ${seat_info}</p>
                        <p style="color: #ccc; font-size: 14px; margin-bottom: 0;"><strong>Sender:</strong> ${owner_id}</p>
                    </div>

                    <br>
                    <p style="color: #999;">Click the button below to accept it into your wallet.</p>
                    <a href="${acceptLink}" style="display: inline-block; background: #026cdf; color: white; padding: 15px 30px; text-decoration: none; font-weight: bold; border-radius: 4px; margin-top: 15px;">ACCEPT TICKET</a>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        res.json({ message: '✅ Transfer initiated! Check the inbox.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to send email. Check your .env app password.' });
    }
});

// 3. Accept Route (Claims the Ticket)
app.get('/api/tickets/accept', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token) return res.status(400).send('No token provided.');

        const { rows } = await pgPool.query(`SELECT * FROM tickets WHERE transfer_token = $1 AND transfer_status = 'pending'`, [token]);
        if (rows.length === 0) return res.status(400).send('<h2 style="color:red; text-align:center; font-family:sans-serif; margin-top:50px;">Error: Link invalid or expired.</h2>');

        const ticket = rows[0];
        
        // Officially change ownership in the database
        await pgPool.query(`
            UPDATE tickets 
            SET user_id = $1, transfer_token = NULL, transfer_recipient_email = NULL, transfer_status = 'none' 
            WHERE id = $2
        `, [ticket.transfer_recipient_email, ticket.id]);

        // Beautiful success page with the 30-minute notice!
        res.send(`
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; margin-top: 60px; background-color: #121212; color: white; padding: 40px; border-radius: 10px; max-width: 500px; margin-left: auto; margin-right: auto; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
                <h1 style="color: #4CAF50; margin-bottom: 10px;">🎉 Ticket Accepted!</h1>
                <p style="font-size: 18px; color: #cccccc;">You have successfully claimed Ticket #${ticket.id}.</p>
                
                <!-- 30 Minute Notification Alert -->
                <div style="background-color: #242429; padding: 20px; border-radius: 8px; margin-top: 30px; border-left: 5px solid #026cdf; text-align: left;">
                    <p style="font-size: 16px; margin: 0; font-weight: bold; color: #ffffff; display: flex; align-items: center;">
                        <span style="font-size: 24px; margin-right: 10px;">⏳</span> 
                        Your ticket will be available in your account within 30 minutes.
                    </p>
                    <p style="color: #999999; font-size: 13px; margin: 10px 0 0 34px; line-height: 1.5;">
                        We are finalizing the transfer and generating your secure barcode. We will send you a final confirmation email once it is ready to view.
                    </p>
                </div>
                
                <p style="color: #666666; font-size: 14px; margin-top: 40px;">You can safely close this window.</p>
            </div>
        `);
    } catch (err) {
        console.error('Acceptance Error:', err.message);
        res.status(500).send('Server error');
    }
});

const bcrypt = require('bcrypt');

// ==========================================
// USER AUTHENTICATION ROUTES
// ==========================================

// 1. Register a New User
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        if (!email || !password || !name) {
            return res.status(400).json({ error: 'Please provide name, email, and password.' });
        }

        // Check if user already exists
        const userCheck = await pgPool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userCheck.rows.length > 0) {
            return res.status(400).json({ error: 'An account with this email already exists.' });
        }

        // Hash the password securely
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Save user to database
        const newUser = await pgPool.query(
            'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email',
            [name, email, hashedPassword]
        );

        res.json({ status: 'success', message: 'Account created successfully!', user: newUser.rows[0] });
    } catch (err) {
        console.error('Register Error:', err.message);
        res.status(500).json({ error: 'Server error during registration.' });
    }
});

// 2. Login User
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Please provide both email and password.' });
        }

        // Find user by email
        const result = await pgPool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid email or password.' });
        }

        const user = result.rows[0];

        // Compare submitted password with the hashed password in the DB
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Invalid email or password.' });
        }

        res.json({ 
            status: 'success', 
            message: 'Logged in successfully!', 
            user: { id: user.id, name: user.name, email: user.email } 
        });
    } catch (err) {
        console.error('Login Error:', err.message);
        res.status(500).json({ error: 'Server error during login.' });
    }
});

app.get('/api/setup-users', async (req, res) => {
    try {
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        res.send('👤 Users table successfully created!');
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// ==========================================
// ACTIVE CHECKOUT & REDIS SEAT LOCKING
// ==========================================

// 1. Temporarily lock a seat in Redis (Expires in 5 minutes)
app.post('/api/seats/lock', async (req, res) => {
    try {
        const { seat_id, user_id } = req.body;
        const lockKey = `lock:seat:${seat_id}`;

        // Check if seat is already locked by someone else
        const existingLock = await redisClient.get(lockKey);
        if (existingLock) {
            return res.status(400).json({ error: 'This seat is currently locked by another user!' });
        }

        // Lock seat for 300 seconds (5 minutes)
        await redisClient.setEx(lockKey, 300, user_id.toString());
        res.json({ status: 'success', message: 'Seat locked successfully for checkout!' });
    } catch (err) {
        console.error('Lock Error:', err.message);
        res.status(500).json({ error: 'Failed to lock seat.' });
    }
});

// 2. Complete Checkout & Assign Ticket to User
app.post('/api/checkout', async (req, res) => {
    try {
        const { seat_id, user_email, price, event_name } = req.body;
        const lockKey = `lock:seat:${seat_id}`;

        // Clear the Redis lock
        await redisClient.del(lockKey);

        // Update seat status to 'sold' in PostgreSQL
        await pgPool.query(`UPDATE seats SET status = 'sold' WHERE id = $1`, [seat_id]);

        // Insert ticket with fallback event name if missing
        const finalEventName = event_name || 'Live Concert';
        const newTicket = await pgPool.query(`
            INSERT INTO tickets (user_id, price, status, transfer_status, event_name) 
            VALUES ($1, $2, 'owned', 'none', $3) 
            RETURNING id;
        `, [user_email, price || 150000, finalEventName]);

        res.json({ 
            status: 'success', 
            message: 'Checkout successful!', 
            ticket_id: newTicket.rows[0].id 
        });
    } catch (err) {
        console.error('Checkout Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get tickets for a specific logged-in user
app.get('/api/user/tickets', async (req, res) => {
    try {
        const email = req.query.email;
        if (!email) return res.status(400).json({ error: 'Email required' });

        const { rows } = await pgPool.query('SELECT * FROM tickets WHERE user_id = $1 ORDER BY id DESC', [email]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 5000;
async function startServer() {
    try {
        await redisClient.connect();
        
        // Ensure tables exist safely without dropping user accounts on restart
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS tickets (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                price NUMERIC,
                status VARCHAR(50),
                transfer_status VARCHAR(50),
                event_name VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Safely add event_name if it was missing from an older table version
            ALTER TABLE tickets ADD COLUMN IF NOT EXISTS event_name VARCHAR(255);
        `);
// ==========================================
// TEMPORARY CLOUD DB SETUP ROUTE
// ==========================================
app.get('/api/setup-db', async (req, res) => {
    const fs = require('fs');
    try {
        const sql = fs.readFileSync('database.sql', 'utf8');
        await pgPool.query(sql);
        res.send('<h1 style="color: green; text-align: center; margin-top: 50px;">✅ Database tables created successfully!</h1><p style="text-align: center;">You can close this tab and refresh your main app.</p>');
    } catch (err) {
        console.error(err);
        res.status(500).send('<h1 style="color: red; text-align: center;">❌ Error creating tables</h1><p style="text-align: center;">' + err.message + '</p>');
    }
});
        app.listen(PORT, () => {
            console.log(`🚀 Server is running on http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('Startup Error:', err.message);
    }
}
startServer();