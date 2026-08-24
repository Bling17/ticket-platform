document.addEventListener('DOMContentLoaded', () => {
    const mcrCard = document.getElementById('mcr-card');
    const eventGrid = document.querySelector('.tm-event-grid');
    const ticketSection = document.getElementById('ticket-purchasing');
    const backBtn = document.getElementById('back-btn');

    // 1. Navigation: Click the Event Card to view seats
    mcrCard.addEventListener('click', () => {
        eventGrid.classList.add('hidden');
        ticketSection.classList.remove('hidden');
        fetchVenueData();
        renderTestSeats();
        setupCheckout();
    });

    // 2. Navigation: Go back to Event Grid
    backBtn.addEventListener('click', () => {
        ticketSection.classList.add('hidden');
        eventGrid.classList.remove('hidden');
        document.getElementById('seat-map').innerHTML = ''; // Clear seats
        document.getElementById('checkout-section').classList.add('hidden'); // Hide checkout
    });
});

// 3. Fetch Eko Convention Centre from PostgreSQL
async function fetchVenueData() {
    const venueNameDisplay = document.getElementById('venue-name');
    try {
        const response = await fetch('/api/venues');
        const venues = await response.json();
        if (venues.length > 0) {
            venueNameDisplay.textContent = `${venues[0].name}, ${venues[0].city}`;
        }
    } catch (error) {
        console.error('Error fetching venue:', error);
    }
}

// 4. Render Seats & Redis Locking
function renderTestSeats() {
    const seatMap = document.getElementById('seat-map');
    seatMap.innerHTML = ''; // clear previous

    for (let i = 1; i <= 12; i++) {
        const seatDiv = document.createElement('div');
        seatDiv.className = 'seat';
        seatDiv.textContent = `A${i}`;
        
        seatDiv.addEventListener('click', async () => {
            const ticketId = 1; 
            const userId = 'user_joshua_123';
            seatDiv.style.backgroundColor = '#ff9800'; 
            seatDiv.textContent = '...';

            try {
                const response = await fetch('/api/tickets/lock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ticket_id: ticketId, user_id: userId })
                });
                
                if (response.ok) {
                    seatDiv.style.backgroundColor = '#f44336'; 
                    seatDiv.style.borderColor = '#f44336';
                    seatDiv.textContent = 'LOCKED';
                    seatDiv.style.pointerEvents = 'none';
                    
                    document.getElementById('checkout-section').classList.remove('hidden');
                    document.getElementById('checkout-seat-name').textContent = `A${i} (Locked for 10 min)`;
                } else {
                    const data = await response.json();
                    seatDiv.style.backgroundColor = '#2c2c2c'; 
                    seatDiv.textContent = `A${i}`;
                    alert(`Blocked: ${data.error}`);
                }
            } catch (error) {
                console.error('Lock error:', error);
            }
        });
        seatMap.appendChild(seatDiv);
    }
}

// 5. Complete Purchase
function setupCheckout() {
    const buyBtn = document.getElementById('buy-btn');
    const checkoutMessage = document.getElementById('checkout-message');
    
    // Remove old listeners to prevent double-firing
    const newBuyBtn = buyBtn.cloneNode(true);
    buyBtn.parentNode.replaceChild(newBuyBtn, buyBtn);

    newBuyBtn.addEventListener('click', async () => {
        newBuyBtn.textContent = 'Processing...';
        newBuyBtn.disabled = true;

        try {
            const response = await fetch('/api/tickets/buy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticket_id: 1, user_id: 'user_joshua_123' })
            });

            if (response.ok) {
                checkoutMessage.textContent = '🎉 Payment Successful!';
                checkoutMessage.style.color = '#4CAF50';
                newBuyBtn.style.display = 'none';
            } else {
                const data = await response.json();
                checkoutMessage.textContent = `Error: ${data.error}`;
                checkoutMessage.style.color = '#f44336';
                newBuyBtn.textContent = 'Confirm Purchase';
                newBuyBtn.disabled = false;
            }
        } catch (error) {
            checkoutMessage.textContent = 'Failed to process payment.';
            checkoutMessage.style.color = '#f44336';
        }
    });
}