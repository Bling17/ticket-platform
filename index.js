const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const redis = require('redis');
const cors = require('cors');
require('dotenv').config();
const { Resend } = require('resend');

// ==========================================
// RESEND EMAIL SETUP
// ==========================================
const resend = new Resend(process.env.RESEND_API_KEY);

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
// DATABASE INITIALIZATION
// ==========================================
async function initializeDatabase() {
    try {
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS venues (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                city VARCHAR(100) NOT NULL,
                capacity INT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS events (
                id SERIAL PRIMARY KEY,
                venue_id INT REFERENCES venues(id),
                title VARCHAR(200) NOT NULL,
                start_time TIMESTAMP NOT NULL,
                status VARCHAR(50) DEFAULT 'upcoming',
                image_url TEXT
            );

            CREATE TABLE IF NOT EXISTS seats (
                id SERIAL PRIMARY KEY,
                event_id INT REFERENCES events(id),
                section VARCHAR(50),
                seat_row VARCHAR(50),
                seat_number INT,
                price INTEGER DEFAULT 150000,
                status VARCHAR(50) DEFAULT 'available'
            );

            CREATE TABLE IF NOT EXISTS tickets (
                id SERIAL PRIMARY KEY,
                event_id INT REFERENCES events(id),
                seat_id INT REFERENCES seats(id),
                price DECIMAL(10, 2) NOT NULL,
                status VARCHAR(20) DEFAULT 'available',
                user_id VARCHAR(255),
                event_name VARCHAR(255),
                transfer_token VARCHAR(255),
                transfer_recipient_email VARCHAR(255),
                transfer_status VARCHAR(50) DEFAULT 'none'
            );
        `);
        console.log('✅ Database tables initialized successfully');
    } catch (err) {
        console.error('❌ Database initialization error:', err.message);
    }
}

// ==========================================
// TICKETMASTER SEARCH & LIVE FETCH
// ==========================================
app.get('/api/search', async (req, res) => {
    try {
        const keyword = req.query.keyword;
        const searchTerm = keyword ? keyword : 'Music';
        const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${process.env.TICKETMASTER_API_KEY}&keyword=${encodeURIComponent(searchTerm)}`;
        
        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok || !data._embedded || !data._embedded.events || data._embedded.events.length === 0) {
            return res.status(404).json({ error: 'No live events found for this search.', details: data });
        }

        await pgPool.query(`ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_event_id_fkey;`);
        await pgPool.query(`ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_seat_id_fkey;`);
        await pgPool.query(`DELETE FROM seats;`);
        await pgPool.query(`DELETE FROM events;`);
        await pgPool.query(`DELETE FROM venues;`);

        const liveEvents = data._embedded.events;
        let insertedCount = 0;

        for (let event of liveEvents) {
            const title = event.name || 'Event TBA';
            const startTime = event.dates?.start?.dateTime || new Date().toISOString();
            const imageUrl = event.images?.find(img => img.ratio === '16_9')?.url || event.images?.[0]?.url || null;
            
            const venueData = event._embedded?.venues?.[0];
            const venueName = venueData?.name || 'Venue TBA';
            const venueCity = venueData?.city?.name || 'City TBA';
            const venueCapacity = venueData?.capacity || 10000;

            const venueResult = await pgPool.query(
                `INSERT INTO venues (name, city, capacity) VALUES ($1, $2, $3) RETURNING id`,
                [venueName, venueCity, venueCapacity]
            );
            const venueId = venueResult.rows[0].id;

            await pgPool.query(
                `INSERT INTO events (venue_id, title, start_time, status, image_url) VALUES ($1, $2, $3, $4, $5)`,
                [venueId, title, startTime, 'upcoming', imageUrl]
            );
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
        const { rows } = await pgPool.query(`
            SELECT e.id, e.title, e.start_time, e.status, e.venue_id, e.image_url, v.name as venue
            FROM events e
            LEFT JOIN venues v ON e.venue_id = v.id
            ORDER BY e.id ASC
        `);
        res.json(rows);
    } catch (err) {
        console.error("🚨 CRITICAL ERROR IN /api/events:", err);
        res.status(500).json({ error: "Failed to load events", details: err.message });
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
                seat_row VARCHAR(50),
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
                        INSERT INTO seats (event_id, section, seat_row, seat_number, price, status)
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
            'SELECT * FROM seats WHERE event_id = $1 ORDER BY seat_row, seat_number', 
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

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

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
        `);
        res.send('🎟️ Tickets table created successfully!');
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.post('/api/tickets/transfer', async (req, res) => {
    try {
        const { ticket_id, owner_id, recipient_email } = req.body;
        const transferToken = crypto.randomBytes(20).toString('hex'); 

        const result = await pgPool.query(`
            UPDATE tickets 
            SET transfer_token = $1, transfer_recipient_email = $2, transfer_status = 'pending' 
            WHERE id = $3 RETURNING *;
        `, [transferToken, recipient_email, ticket_id]);

        if (result.rows.length === 0) return res.status(400).json({ error: 'Ticket not found.' });

        const detailsQuery = await pgPool.query(`
            SELECT t.*, e.title as event_title, e.start_time, e.image_url, v.name as venue_name, s.section, s.seat_row, s.seat_number
            FROM tickets t
            LEFT JOIN events e ON t.event_id = e.id
            LEFT JOIN venues v ON e.venue_id = v.id
            LEFT JOIN seats s ON t.seat_id = s.id
            WHERE t.id = $1
        `, [ticket_id]);

        const ticketInfo = detailsQuery.rows[0] || {};
        const eventTitle = ticketInfo.event_title || ticketInfo.event_name || 'Live Event';
        const venueName = ticketInfo.venue_name || 'AT&T Stadium';
        const startTime = ticketInfo.start_time
            ? new Date(ticketInfo.start_time).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
            : 'Sun, Aug 16, 2026, 8:00 PM';
        const seatText = ticketInfo.section ? `Section ${ticketInfo.section}, Row ${ticketInfo.seat_row}, Seat ${ticketInfo.seat_number}` : (req.body.seat_info || 'General Admission');
        const imageUrl = ticketInfo.image_url || 'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?auto=format&fit=crop&w=600&q=80';

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const acceptLink = `${protocol}://${host}/api/tickets/accept?token=${transferToken}`;

        const safeOwner = escapeHtml(owner_id);
        const safeEvent = escapeHtml(eventTitle);
        const safeSeat = escapeHtml(seatText);
        const safeDate = escapeHtml(startTime);
        const safeVenue = escapeHtml(venueName);
        const safeImage = escapeHtml(imageUrl);

        // Safe fallback routing for Resend sandbox restriction during demos
        const targetInboxEmail = process.env.RESEND_TEST_INBOX || 'rowlandjoshi7@gmail.com';

        const htmlContent = `
            <div style="margin:0; padding:24px 12px; background:#121212; font-family:Arial,Helvetica,sans-serif; color:#ffffff;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px; margin:0 auto; background:#1b1b20; border-radius:8px; overflow:hidden;">
                    <tr>
                        <td style="padding:30px 30px 20px; color:#d4d4d8; font-size:15px; line-height:1.6;">
                            <p style="margin:0 0 8px; color:#918ff2; font-size:12px; text-transform:uppercase; font-weight:bold;">[Portfolio Demo Mode: Intended for ${escapeHtml(recipient_email)}]</p>
                            <p style="margin:0 0 16px;">Hi there,</p>
                            <p style="margin:0;">There are ticket(s) waiting to be accepted in your account. Accepting the ticket(s) will allow you to enter the event easily, using your own phone.</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:0 30px;">
                            <div style="width:100%; height:220px; background:url('${safeImage}') center/cover no-repeat; border-radius:4px 4px 0 0;"></div>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:0 30px 30px;">
                            <div style="background:#242429; padding:24px; border-radius:0 0 4px 4px;">
                                <h2 style="margin:0 0 8px; color:#ffffff; font-size:16px; line-height:1.4; font-weight:700;">${safeEvent}</h2>
                                <p style="margin:0 0 16px; color:#96969d; font-size:13px; line-height:1.5;">${safeDate} • ${safeVenue}</p>
                                <div style="border-top:1px solid #2f2f36; padding-top:16px; margin-bottom:24px;">
                                    <p style="margin:0 0 6px; color:#ffffff; font-size:15px; font-weight:700;">${safeSeat}</p>
                                    <p style="margin:0; color:#96969d; font-size:13px;">Transfer Pending</p>
                                </div>
                                <a href="${acceptLink}" style="display:block; padding:16px 20px; background:#918ff2; color:#111118; text-align:center; text-decoration:none; font-size:15px; font-weight:700; border-radius:4px; margin-bottom:24px;">ACCEPT TICKETS</a>
                            </div>
                        </td>
                    </tr>
                </table>
            </div>
        `;

        // Safe Email Send Wrapper to prevent sandbox crashes
        try {
            await resend.emails.send({
                from: 'Ticketmaster <onboarding@resend.dev>',
                to: targetInboxEmail,
                subject: `${owner_id} has sent you a ticket to ${eventTitle}!`,
                html: htmlContent
            });
        } catch (resendErr) {
            console.log('Resend Sandbox Notice (Handled safely):', resendErr.message);
        }

        res.json({ message: '✅ Transfer initiated! Check the inbox.' });
    } catch (err) {
        console.error('Transfer Error:', err);
        res.status(500).json({ error: 'Failed to send email: ' + err.message });
    }
});

app.get('/api/tickets/accept', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token) return res.status(400).send('No token provided.');

        const { rows } = await pgPool.query(`SELECT * FROM tickets WHERE transfer_token = $1 AND transfer_status = 'pending'`, [token]);
        if (rows.length === 0) return res.status(400).send('<h2 style="color:red; text-align:center; font-family:sans-serif; margin-top:50px;">Error: Link invalid or expired.</h2>');

        const ticket = rows[0];
        
        await pgPool.query(`
            UPDATE tickets 
            SET user_id = $1, transfer_token = NULL, transfer_recipient_email = NULL, transfer_status = 'none' 
            WHERE id = $2
        `, [ticket.transfer_recipient_email, ticket.id]);

        res.send(`
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; margin-top: 60px; background-color: #121212; color: white; padding: 40px; border-radius: 10px; max-width: 500px; margin-left: auto; margin-right: auto;">
                <h1 style="color: #4CAF50; margin-bottom: 10px;">🎉 Ticket Accepted!</h1>
                <p style="font-size: 18px; color: #cccccc;">You have successfully claimed Ticket #${ticket.id}.</p>
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

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        if (!email || !password || !name) {
            return res.status(400).json({ error: 'Please provide name, email, and password.' });
        }

        const userCheck = await pgPool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userCheck.rows.length > 0) {
            return res.status(400).json({ error: 'An account with this email already exists.' });
        }

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const newUser = await pgPool.query(
            'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email',
            [name, email, hashedPassword]
        );

        res.json({ status: 'success', message: 'Account created successfully!', user: newUser.rows[0] });
    } catch (err) {
        console.error('Register Error:', err.message);
        res.status(500).json({ error: 'Server error during registration: ' + err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Please provide both email and password.' });
        }

        const result = await pgPool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid email or password.' });
        }

        const user = result.rows[0];

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

// ==========================================
// ACTIVE CHECKOUT & REDIS SEAT LOCKING
// ==========================================

app.post('/api/seats/lock', async (req, res) => {
    try {
        const { seat_id, user_id } = req.body;
        const lockKey = `lock:seat:${seat_id}`;

        const existingLock = await redisClient.get(lockKey);
        if (existingLock) {
            return res.status(400).json({ error: 'This seat is currently locked by another user!' });
        }

        await redisClient.setEx(lockKey, 300, user_id.toString());
        res.json({ status: 'success', message: 'Seat locked successfully for checkout!' });
    } catch (err) {
        console.error('Lock Error:', err.message);
        res.status(500).json({ error: 'Failed to lock seat.' });
    }
});

app.post('/api/checkout', async (req, res) => {
    try {
        const { seat_id, user_email, price } = req.body;
        const lockKey = `lock:seat:${seat_id}`;

        if (!user_email || !seat_id) {
            return res.status(400).json({ error: 'Missing user_email or seat_id' });
        }

        const seatResult = await pgPool.query('SELECT event_id FROM seats WHERE id = $1', [seat_id]);
        if (seatResult.rows.length === 0) {
            return res.status(400).json({ error: 'Seat not found' });
        }
        const event_id = seatResult.rows[0].event_id;

        const eventResult = await pgPool.query('SELECT title FROM events WHERE id = $1', [event_id]);
        const event_name = eventResult.rows.length > 0 ? eventResult.rows[0].title : 'Live Event';

        try {
            await redisClient.del(lockKey);
        } catch (redisErr) {
            console.log('Redis delete warning:', redisErr.message);
        }

        await pgPool.query(`UPDATE seats SET status = 'sold' WHERE id = $1`, [seat_id]);

        const newTicket = await pgPool.query(`
            INSERT INTO tickets (event_id, seat_id, user_id, price, status, transfer_status, event_name) 
            VALUES ($1, $2, $3, $4, 'available', 'none', $5) 
            RETURNING id;
        `, [event_id, seat_id, user_email, price || 150000, event_name]);

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

app.get('/api/fix-users-table', async (req, res) => {
    try {
        await pgPool.query(`DROP TABLE IF EXISTS users CASCADE;`);
        await pgPool.query(`
            CREATE TABLE users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        res.send('✅ Users table successfully fixed with password column!');
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 5000;
async function startServer() {
    try {
        await redisClient.connect().catch(e => console.log('Redis connection notice:', e.message));
        await initializeDatabase();

        app.listen(PORT, () => {
            console.log(`🚀 Server is running on port ${PORT}`);
        });
    } catch (err) {
        console.error('Startup Error:', err.message);
    }
}

startServer();