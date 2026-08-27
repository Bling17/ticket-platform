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
        user: 'rowlandjosh17@gmail.com', // Your actual Gmail
        pass: 'tryp bstv wjae cakh' // No spaces
    }
});

// Initialize the Express app
const app = express();
app.use(cors());
app.use(express.json()); // Allows us to read JSON data sent in requests
app.use(express.static('public'));

// 1. Connect to PostgreSQL
const pgPool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'postgres', // Matches the default Docker DB
    password: 'mysecretpassword', 
    port: 5432,
});

pgPool.on('connect', () => {
    console.log('Connected to PostgreSQL Database');
});

// 2. Connect to Redis
const redisClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.log('Redis Error:', err));

// 3. Create a Health Check Route
app.get('/api/health', async (req, res) => {
    try {
        // Test Postgres
        const dbResult = await pgPool.query('SELECT NOW()');
        
        // Test Redis
        await redisClient.set('test_key', 'Redis is working!');
        const redisResult = await redisClient.get('test_key');

        res.json({
            status: 'success',
            message: 'Backend is fully operational',
            db_time: dbResult.rows[0].now,
            redis_status: redisResult
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Connection failed' });
    }
});

// ==========================================
// TICKETING API ROUTES
// ==========================================

// --- VENUES ---

// Create a new venue
app.post('/api/venues', async (req, res) => {
    try {
        const { name, city, capacity } = req.body;
        const newVenue = await pgPool.query(
            'INSERT INTO venues (name, city, capacity) VALUES ($1, $2, $3) RETURNING *',
            [name, city, capacity]
        );
        res.json(newVenue.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get all venues
app.get('/api/venues', async (req, res) => {
    try {
        const allVenues = await pgPool.query('SELECT * FROM venues');
        res.json(allVenues.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==========================================
// TEMPORARY ROUTE: Upgrade Database for Transfers
// ==========================================
app.get('/api/upgrade-db', async (req, res) => {
    try {
        await pgPool.query(`
            ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_user_id_fkey;
            ALTER TABLE tickets ALTER COLUMN user_id TYPE VARCHAR(255);
            
            ALTER TABLE tickets 
            ADD COLUMN IF NOT EXISTS transfer_token VARCHAR(255), 
            ADD COLUMN IF NOT EXISTS transfer_recipient_email VARCHAR(255), 
            ADD COLUMN IF NOT EXISTS transfer_status VARCHAR(50) DEFAULT 'none';
        `);
        res.send('✅ Database upgraded for transfers!');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ==========================================
// TEMPORARY ROUTE: Give myself a ticket
// ==========================================
app.get('/api/seed-ticket', async (req, res) => {
    try {
        // This forces ticket #1 to exist with a price!
        await pgPool.query(`
            INSERT INTO tickets (id, user_id, status, price) 
            VALUES (1, 'user_joshua_123', 'owned', 150000)
            ON CONFLICT (id) 
            DO UPDATE SET user_id = 'user_joshua_123', status = 'owned', price = 150000;
        `);
        res.send('🎟️ Ticket #1 successfully added to your wallet!');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// TEMPORARY ROUTE: Seed Dynamic Events
// ==========================================
app.get('/api/seed-events', async (req, res) => {
    try {
        // 1. Ensure the events table has ALL the required columns
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS events (
                id SERIAL PRIMARY KEY
            );
            ALTER TABLE events ADD COLUMN IF NOT EXISTS title VARCHAR(255);
            ALTER TABLE events ADD COLUMN IF NOT EXISTS date VARCHAR(255);
            ALTER TABLE events ADD COLUMN IF NOT EXISTS venue VARCHAR(255);
            ALTER TABLE events ADD COLUMN IF NOT EXISTS image_url TEXT;
            
            -- NEW: Delete the old, strict start_time column
            ALTER TABLE events DROP COLUMN IF EXISTS start_time;
        `);

        // 2. Drop the strict linking rule so we can safely refresh the events
        await pgPool.query(`ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_event_id_fkey;`);

        // 3. Clear old test data and insert 3 dynamic events
        await pgPool.query(`DELETE FROM events;`);
        await pgPool.query(`
            INSERT INTO events (title, date, venue, image_url) VALUES 
            ('My Chemical Romance', 'Oct 25 • 7:00 PM', 'Eko Convention Centre', 'https://images.unsplash.com/photo-1540039155733-d7696d4eb98b?q=80&w=800&auto=format&fit=crop'),
            ('Lagos Tech Summit', 'Nov 12 • 9:00 AM', 'Landmark Centre', 'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?q=80&w=800&auto=format&fit=crop'),
            ('Burna Boy Live', 'Dec 20 • 8:00 PM', 'Eko Atlantic City', 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?q=80&w=800&auto=format&fit=crop');
        `);
        
        res.send('🖼️ Events table seeded with dynamic images!');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// SEAT ENGINE: Generate Dynamic Seats
// ==========================================
app.get('/api/generate-seats', async (req, res) => {
    try {
        // Drop any strict linking rules that might block us
        await pgPool.query(`ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_seat_id_fkey;`);

        // 1. Destroy the old outdated table, then build the new correct one
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

        // 2. Fetch all events currently in the database
        const { rows: events } = await pgPool.query('SELECT id FROM events');
        
        // 3. Generate a VIP seating section (3 rows, 5 seats each) for EVERY event
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
        res.send(`💺 Success! Generated ${insertCount} interactive seats across your events.`);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ==========================================
// SEAT ENGINE: Fetch Seats for a Specific Event
// ==========================================
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
// FETCH EVENTS ROUTE
// ==========================================
app.get('/api/events', async (req, res) => {
    try {
        const { rows } = await pgPool.query('SELECT * FROM events ORDER BY id ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- EVENTS ---

// Create a new event
app.post('/api/events', async (req, res) => {
    try {
        const { venue_id, title, start_time } = req.body;
        const newEvent = await pgPool.query(
            'INSERT INTO events (venue_id, title, start_time) VALUES ($1, $2, $3) RETURNING *',
            [venue_id, title, start_time]
        );
        res.json(newEvent.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get all events
app.get('/api/events', async (req, res) => {
    try {
        const allEvents = await pgPool.query('SELECT * FROM events');
        res.json(allEvents.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- SEATS ---

// Create a physical seat in a venue
app.post('/api/seats', async (req, res) => {
    try {
        const { venue_id, section, seat_row, seat_number } = req.body;
        const newSeat = await pgPool.query(
            'INSERT INTO seats (venue_id, section, seat_row, seat_number) VALUES ($1, $2, $3, $4) RETURNING *',
            [venue_id, section, seat_row, seat_number]
        );
        res.json(newSeat.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- TICKETS (The Inventory) ---

// Create a ticket to link an event to a seat
app.post('/api/tickets', async (req, res) => {
    try {
        const { event_id, seat_id, price } = req.body;
        const newTicket = await pgPool.query(
            'INSERT INTO tickets (event_id, seat_id, price) VALUES ($1, $2, $3) RETURNING *',
            [event_id, seat_id, price]
        );
        res.json(newTicket.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==========================================
// REDIS LOCKING (The Checkout Timer)
// ==========================================

// Lock a ticket for a user (Temporary Reservation)
app.post('/api/tickets/lock', async (req, res) => {
    try {
        const { ticket_id, user_id } = req.body;
        const lockKey = `ticket_lock:${ticket_id}`;

        // Attempt to lock the seat in Redis for 10 minutes (600 seconds)
        // NX: "Not Exists" - only lock it if someone else hasn't already!
        // EX: "Expiration" - auto-delete the lock after 600 seconds.
        const locked = await redisClient.set(lockKey, user_id, {
            NX: true,
            EX: 600
        });

        if (!locked) {
            return res.status(409).json({ 
                error: 'Seat is currently reserved by another user. Please try again later.' 
            });
        }

        res.json({
            status: 'success',
            message: 'Ticket temporarily reserved for 10 minutes.',
            ticket_id,
            user_id
        });
    } catch (err) {
        console.error('Redis Lock Error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==========================================
// CHECKOUT (The Final Purchase)
// ==========================================

// Buy the locked ticket
app.post('/api/tickets/buy', async (req, res) => {
    try {
        const { ticket_id, user_id } = req.body;
        const lockKey = `ticket_lock:${ticket_id}`;

        // 1. Verify this exact user holds the Redis lock
        const currentLockOwner = await redisClient.get(lockKey);

        if (currentLockOwner !== user_id) {
            return res.status(400).json({ 
                error: 'Checkout failed. Your reservation expired or you do not have this ticket reserved.' 
            });
        }

        // 2. (Pretend a Stripe credit card payment is processed here)

        // 3. Delete the lock from Redis so it doesn't stay reserved forever
        await redisClient.del(lockKey);

        // 4. Send the success response!
        res.json({
            status: 'success',
            message: 'Payment successful! Ticket has been officially purchased.',
            ticket_id: ticket_id,
            owner: user_id
        });
    } catch (err) {
        console.error('Checkout Error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// 4. Start the Server after Redis is ready
const PORT = 5000;

async function startServer() {
    try {
        await redisClient.connect();
        app.listen(PORT, () => {
            console.log(`Server is running on http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('Unable to connect to Redis:', err.message);
        process.exitCode = 1;
    }
}

startServer();
// ==========================================
// DYNAMIC SEATS: Seed realistic seats
// ==========================================
app.get('/api/seed-seats', async (req, res) => {
    try {
        // Creates a VIP row (A) and a Regular row (B)
        await pgPool.query(`
            INSERT INTO seats (id, venue_id, seat_row, seat_number, price) VALUES 
            (101, 1, 'A', 1, 150000), (102, 1, 'A', 2, 150000), (103, 1, 'A', 3, 150000), (104, 1, 'A', 4, 150000),
            (105, 1, 'B', 1, 75000), (106, 1, 'B', 2, 75000), (107, 1, 'B', 3, 75000), (108, 1, 'B', 4, 75000)
            ON CONFLICT (id) DO NOTHING;
        `);
        res.send('🪑 Dynamic seats successfully planted in the database!');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// DYNAMIC SEATS: Fetch seats for the frontend
// ==========================================
app.get('/api/seats', async (req, res) => {
    try {
        // Grab all seats and sort them neatly by Row and Number
        const result = await pgPool.query('SELECT * FROM seats ORDER BY seat_row, seat_number');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// TICKET TRANSFER: Initiate the Transfer (REAL EMAIL)
// ==========================================
app.post('/api/tickets/transfer', async (req, res) => {
    try {
        const { ticket_id, owner_id, recipient_email } = req.body;
        const transferToken = crypto.randomBytes(20).toString('hex');

        const updateQuery = `
            UPDATE tickets 
            SET transfer_token = $1, transfer_recipient_email = $2, transfer_status = 'pending' 
            WHERE id = $3 AND user_id = $4
            RETURNING *;
        `;
        const result = await pgPool.query(updateQuery, [transferToken, recipient_email, ticket_id, owner_id]);

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Ticket not found or you do not own it.' });
        }

        const acceptLink = `http://localhost:5000/api/tickets/accept?token=${transferToken}`;

        // The HTML Template perfectly mimicking the dark-mode aesthetic
        const emailHTML = `
            <div style="background-color: #1a1a1f; color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 0; margin: 0; width: 100%; max-width: 600px; margin: auto;">
                <div style="padding: 30px;">
                    <h2 style="color: #026cdf; font-style: italic; font-weight: 800; margin-bottom: 40px; font-size: 20px;">ticketmaster</h2>
                    
                    <h1 style="font-size: 22px; text-align: center; font-weight: 500; margin-bottom: 40px; color: #ffffff;">
                        ${owner_id} has transferred you 1 ticket to<br>BTS WORLD TOUR 'ARIRANG' IN ARLINGTON
                    </h1>
                    
                    <p style="font-size: 15px; color: #dddddd;">Hi there,</p>
                    <p style="font-size: 15px; color: #dddddd; line-height: 1.5; margin-bottom: 30px;">
                        There are ticket(s) waiting to be accepted in your account. Accepting the ticket(s) will allow you to enter the event easily, using your own phone.
                    </p>
                    
                    <!-- Dynamic Event Image -->
                    <img src="https://images.unsplash.com/photo-1540039155733-d7696d4eb98b?q=80&w=600&auto=format&fit=crop" alt="Concert Stage" style="width: 100%; border-top-left-radius: 10px; border-top-right-radius: 10px; display: block;">
                    
                    <!-- Details Card -->
                    <div style="background-color: #242429; padding: 25px; border-bottom-left-radius: 10px; border-bottom-right-radius: 10px; margin-bottom: 30px;">
                        <p style="margin: 0 0 5px 0; font-size: 16px; font-weight: bold; color: #ffffff;">BTS WORLD TOUR 'ARIRANG' IN ARLINGTON</p>
                        <p style="margin: 0 0 20px 0; font-size: 14px; color: #999999;">Sun, Aug 16, 2026, 8:00 PM • AT&T Stadium</p>
                        
                        <p style="margin: 0 0 5px 0; font-size: 16px; font-weight: bold; color: #ffffff;">Section 5, Row 4, Seat 5</p>
                        <p style="margin: 0 0 25px 0; font-size: 14px; color: #999999;">Transfer Pending</p>
                        
                        <!-- Accept Button -->
                        <div style="text-align: center; margin-bottom: 25px;">
                            <a href="${acceptLink}" style="background-color: #9193f4; color: #000000; padding: 16px 0; width: 100%; display: inline-block; text-decoration: none; font-weight: bold; font-size: 15px; border-radius: 4px; letter-spacing: 1px;">ACCEPT TICKETS</a>
                        </div>
                        
                        <p style="font-size: 12px; color: #888888; line-height: 1.5;">
                            By clicking 'ACCEPT TICKETS', you agree to our Terms of Use and any applicable ticket back terms.<br><br>
                            If the ticket(s) were obtained fraudulently by the person transferring them, they may be canceled at any time and removed from your account.<br><br>
                            This email is <strong>NOT</strong> your ticket.
                        </p>
                    </div>
                </div>
            </div>
        `;

        // Configure the Email Payload
        const mailOptions = {
            from: '"Ticketmaster Update" <rowlandjosh17@gmail.com>',
            to: recipient_email,
            subject: 'You received 1 ticket to BTS WORLD TOUR \'ARIRANG\' IN ARLINGTON',
            html: emailHTML
        };

        // Send the real email!
        await transporter.sendMail(mailOptions);
        console.log('📧 REAL EMAIL SENT SUCCESSFULLY TO:', recipient_email);

        res.json({
            status: 'success',
            message: 'Transfer initiated! Check your real inbox.',
            ticket_id: ticket_id,
            status: 'pending'
        });

    } catch (err) {
        console.error('Transfer Error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});
// ==========================================
// TICKET TRANSFER: Accept the Transfer
// ==========================================
app.get('/api/tickets/accept', async (req, res) => {
    try {
        const token = req.query.token;

        if (!token) {
            return res.status(400).send('<h1 style="color: red; text-align: center;">Error: No transfer link provided.</h1>');
        }

        const findQuery = `SELECT * FROM tickets WHERE transfer_token = $1 AND transfer_status = 'pending'`;
        const { rows } = await pgPool.query(findQuery, [token]);

        if (rows.length === 0) {
            return res.status(400).send('<h1 style="color: red; text-align: center;">Error: Invalid or expired transfer link.</h1>');
        }

        const ticket = rows[0];

        const updateQuery = `
            UPDATE tickets 
            SET user_id = $1, 
                transfer_token = NULL, 
                transfer_recipient_email = NULL, 
                transfer_status = 'none' 
            WHERE id = $2
        `;
        await pgPool.query(updateQuery, [ticket.transfer_recipient_email, ticket.id]);

        // 3. Show a beautiful success page to the friend with the 30-minute notice
        res.send(`
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; margin-top: 50px; background-color: #121212; color: white; padding: 40px; border-radius: 10px; max-width: 500px; margin-left: auto; margin-right: auto; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
                <h1 style="color: #4CAF50; margin-bottom: 10px;">🎉 Ticket Accepted!</h1>
                <p style="font-size: 18px; color: #cccccc;">You have successfully claimed Ticket #${ticket.id}.</p>
                
                <!-- 30 Minute Notification Alert -->
                <div style="background-color: #242429; padding: 20px; border-radius: 8px; margin-top: 30px; border-left: 5px solid #026cdf; text-align: left;">
                    <p style="font-size: 16px; margin: 0; font-weight: bold; color: #ffffff; display: flex; align-items: center;">
                        <span style="font-size: 24px; margin-right: 10px;">⏳</span> 
                        Your ticket will be available in your account within 30 minutes.
                    </p>
                    <p style="color: #999999; font-size: 13px; margin: 10px 0 0 34px;">
                        We are finalizing the transfer and generating your secure barcode. We will send you a final confirmation email once it is ready.
                    </p>
                </div>
                
                <p style="color: #666666; font-size: 14px; margin-top: 40px;">You can safely close this window.</p>
            </div>
        `);

    } catch (err) {
        console.error('Acceptance Error:', err.message);
        res.status(500).send('<h1>Server error</h1>');
    }
});