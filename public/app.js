document.addEventListener('DOMContentLoaded', () => {
    const eventGrid = document.getElementById('dynamic-event-grid');
    const ticketSection = document.getElementById('ticket-purchasing');
    const backBtn = document.getElementById('back-btn');
    const navMyTickets = document.getElementById('nav-my-tickets');
    const myTicketsSection = document.getElementById('my-tickets-section');

    // ==========================================
    // 1. Fetch Events and Build the UI
    // ==========================================
    async function loadEvents() {
        try {
            const response = await fetch('/api/events');
            const events = await response.json();
            
            if (eventGrid) eventGrid.innerHTML = ''; 
            
            events.forEach((event, index) => {
                const card = document.createElement('div');
                card.className = index === 0 ? 'event-card featured' : 'event-card'; 
                
                card.style.backgroundImage = `linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0) 100%), url('${event.image_url}')`;
                card.style.backgroundSize = 'cover';
                card.style.backgroundPosition = 'center';
                
                card.innerHTML = `
                    <div class="card-content">
                        <h3>${event.title}</h3>
                        <p>${event.date} • ${event.venue}</p>
                    </div>
                `;

                card.addEventListener('click', () => {
                    if (eventGrid) eventGrid.classList.add('hidden');
                    if (myTicketsSection) myTicketsSection.classList.add('hidden');
                    if (ticketSection) ticketSection.classList.remove('hidden');
                    
                    document.getElementById('venue-name').textContent = `${event.title} • ${event.venue}`;
                    
                    // Trigger our new Dynamic Engine!
                    renderDynamicSeats(event.id); 
                });

                if (eventGrid) eventGrid.appendChild(card);
            });
        } catch (error) {
            console.error('Error loading events:', error);
            if (eventGrid) eventGrid.innerHTML = '<p style="color:red;">Failed to load events.</p>';
        }
    }

    loadEvents(); // Run the function immediately!

    // ==========================================
    // 2. Navigation Logic
    // ==========================================
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            if (ticketSection) ticketSection.classList.add('hidden');
            if (eventGrid) eventGrid.classList.remove('hidden');
            document.getElementById('seat-map').innerHTML = ''; 
        });
    }

    if (navMyTickets) {
        navMyTickets.addEventListener('click', () => {
            if (eventGrid) eventGrid.classList.add('hidden');
            if (ticketSection) ticketSection.classList.add('hidden');
            if (myTicketsSection) myTicketsSection.classList.remove('hidden');
        });
    }

    // ==========================================
    // 3. Transfer UI Logic
    // ==========================================
    const modal = document.getElementById('transfer-modal');
    const closeBtn = document.querySelector('.close-btn');
    const openTransferBtn = document.getElementById('open-transfer-btn');
    const submitTransferBtn = document.getElementById('submit-transfer-btn');

    if (openTransferBtn) {
        openTransferBtn.addEventListener('click', () => {
            modal.classList.remove('hidden');
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            modal.classList.add('hidden');
            document.getElementById('transfer-message').textContent = ''; 
        });
    }

    if (submitTransferBtn) {
        submitTransferBtn.addEventListener('click', async () => {
            const email = document.getElementById('friend-email').value;
            const msg = document.getElementById('transfer-message');
            
            if (!email) {
                msg.textContent = 'Please enter an email address.';
                msg.style.color = '#f44336';
                return;
            }

            msg.textContent = 'Generating secure link...';
            msg.style.color = '#555';

            try {
                const response = await fetch('/api/tickets/transfer', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ticket_id: 1, owner_id: 'user_joshua_123', recipient_email: email })
                });
                
                const data = await response.json();
                
                if (response.ok) {
                    msg.textContent = '✅ Transfer initiated! Check your real inbox.';
                    msg.style.color = '#4CAF50';
                } else {
                    msg.textContent = `❌ Error: ${data.error}`;
                    msg.style.color = '#f44336';
                }
            } catch (error) {
                msg.textContent = 'Failed to connect to server.';
                msg.style.color = '#f44336';
            }
        });
    }
}); // <--- This cleanly closes the DOMContentLoaded block!

// ==========================================
// 4. DYNAMIC SEAT MAP ENGINE
// ==========================================
async function renderDynamicSeats(eventId) {
    const seatMap = document.getElementById('seat-map');
    seatMap.innerHTML = '<p style="color: #999;">Loading live seat map...</p>';

    try {
        const response = await fetch(`/api/events/${eventId}/seats`);
        const seats = await response.json();
        
        seatMap.innerHTML = ''; 

        const seatGrid = document.createElement('div');
        seatGrid.style.display = 'grid';
        seatGrid.style.gridTemplateColumns = 'repeat(5, 1fr)'; 
        seatGrid.style.gap = '10px';
        seatGrid.style.marginTop = '20px';

        seats.forEach(seat => {
            const seatEl = document.createElement('div');
            seatEl.style.padding = '15px 5px';
            seatEl.style.textAlign = 'center';
            seatEl.style.borderRadius = '5px';
            seatEl.style.fontWeight = 'bold';
            seatEl.style.fontSize = '12px';
            seatEl.textContent = `${seat.row} - ${seat.seat_number}`;

            if (seat.status === 'available') {
                seatEl.style.backgroundColor = '#4CAF50'; 
                seatEl.style.color = 'white';
                seatEl.style.cursor = 'pointer';

                seatEl.addEventListener('click', () => {
                    if (seatEl.style.backgroundColor === 'rgb(76, 175, 80)' || seatEl.style.backgroundColor === '#4CAF50') {
                        seatEl.style.backgroundColor = '#026cdf'; 
                    } else {
                        seatEl.style.backgroundColor = '#4CAF50'; 
                    }
                });
            } else {
                seatEl.style.backgroundColor = '#333'; 
                seatEl.style.color = '#777';
                seatEl.style.cursor = 'not-allowed';
            }
            
            seatGrid.appendChild(seatEl);
        });

        seatMap.appendChild(seatGrid);
    } catch (error) {
        seatMap.innerHTML = '<p style="color:red;">Failed to load seat map.</p>';
    }
}