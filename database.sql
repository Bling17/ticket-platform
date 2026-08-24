-- Users who buy tickets or manage events
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Venues where events happen
CREATE TABLE venues (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    city VARCHAR(100) NOT NULL,
    capacity INT NOT NULL
);

-- The Events themselves
CREATE TABLE events (
    id SERIAL PRIMARY KEY,
    venue_id INT REFERENCES venues(id),
    title VARCHAR(200) NOT NULL,
    start_time TIMESTAMP NOT NULL,
    status VARCHAR(50) DEFAULT 'upcoming' -- upcoming, active, completed
);

-- The physical seats in a venue
CREATE TABLE seats (
    id SERIAL PRIMARY KEY,
    venue_id INT REFERENCES venues(id),
    section VARCHAR(50),
    seat_row VARCHAR(10),
    seat_number INT
);

-- The actual inventory (The most critical table)
CREATE TABLE tickets (
    id SERIAL PRIMARY KEY,
    event_id INT REFERENCES events(id),
    seat_id INT REFERENCES seats(id),
    price DECIMAL(10, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'available', -- available, locked, sold
    user_id INT REFERENCES users(id) -- Null until purchased
);