const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const redis = require('redis');
const cors = require('cors');
require('dotenv').config();

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
// TICKET TRANSFER: Initiate the Transfer
// ==========================================
app.post('/api/tickets/transfer', async (req, res) => {
    try {
        const { ticket_id, owner_id, recipient_email } = req.body;

        // 1. Generate a secure, 40-character random token
        const transferToken = crypto.randomBytes(20).toString('hex');

        // 2. Update the ticket to 'pending' transfer
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

        // 3. Create the magic acceptance link
        const acceptLink = `http://localhost:5000/api/tickets/accept?token=${transferToken}`;

        // 4. Simulate the Email in the console
        console.log('\n=========================================');
        console.log('📧 NEW EMAIL SENT TO:', recipient_email);
        console.log('Subject: You have been sent a ticket for Lagos Tech Summit!');
        console.log('Body: Please click the link below to accept your ticket.');
        console.log('🔗 ACCEPT LINK:', acceptLink);
        console.log('=========================================\n');

        res.json({
            status: 'success',
            message: 'Transfer initiated! Check server console for the email.',
            ticket_id: ticket_id,
            status: 'pending'
        });

    } catch (err) {
        console.error('Transfer Error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});
// ==========================================
// TICKET TRANSFER: Accept the Ticket
// ==========================================
app.get('/api/tickets/accept', async (req, res) => {
    try {
        // 1. Grab the secure token from the URL (?token=xyz)
        const { token } = req.query;

        if (!token) {
            return res.status(400).send('❌ No token provided.');
        }

        // 2. Find the pending ticket and officially change the owner
        const updateQuery = `
            UPDATE tickets 
            SET 
                user_id = 'new_friend_user_999', -- The ticket now belongs to the friend!
                transfer_token = NULL,
                transfer_recipient_email = NULL,
                transfer_status = 'none'
            WHERE transfer_token = $1 AND transfer_status = 'pending'
            RETURNING *;
        `;
        
        const result = await pgPool.query(updateQuery, [token]);

        if (result.rows.length === 0) {
            return res.status(400).send('❌ Invalid, used, or expired transfer link.');
        }

        // 3. Send a beautiful success page back to the friend
        res.send(`
            <div style="font-family: 'Segoe UI', Tahoma, sans-serif; text-align: center; margin-top: 100px; color: #fff; background-color: #121212; padding: 50px; border-radius: 10px; max-width: 500px; margin-left: auto; margin-right: auto; border: 1px solid #333;">
                <h1 style="color: #4CAF50;">🎉 Ticket Accepted!</h1>
                <p style="font-size: 18px;">You are now the official owner of Ticket #${result.rows[0].id}.</p>
                <p style="color: #aaa;">Your secure transfer is complete.</p>
            </div>
            <style>body { background-color: #000; }</style>
        `);

    } catch (err) {
        console.error('Acceptance Error:', err.message);
        res.status(500).send('❌ Server error during acceptance.');
    }
});