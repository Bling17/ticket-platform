document.addEventListener('DOMContentLoaded', () => {
    const eventGrid = document.getElementById('dynamic-event-grid');
    const ticketSection = document.getElementById('ticket-purchasing');
    const backBtn = document.getElementById('back-btn');
    const searchBtn = document.getElementById('search-btn');
    const searchInput = document.getElementById('search-input');

    // ==========================================
    // 1. Fetch Events and Build the UI
    // ==========================================
    async function loadEvents() {
        try {
            const response = await fetch('/api/events');
            
            if (!response.ok) {
                throw new Error(`Server responded with status ${response.status}`);
            }
            
            const events = await response.json();
            
            if (eventGrid) eventGrid.innerHTML = ''; 
            
            if (!Array.isArray(events) || events.length === 0) {
                if (eventGrid) eventGrid.innerHTML = '<p style="color: white; text-align: center; width: 100%;">No events in database. Search above to pull live data!</p>';
                return;
            }

            events.forEach((event, index) => {
                const card = document.createElement('div');
                card.className = index === 0 ? 'event-card featured' : 'event-card'; 
                
                // Use actual image if available, otherwise use gradient
                if (event.image_url) {
                    card.style.backgroundImage = `linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 50%), url('${event.image_url}')`;
                    card.style.backgroundSize = 'cover';
                    card.style.backgroundPosition = 'center';
                } else {
                    card.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
                }
                
                card.innerHTML = `
                    <div class="card-content">
                        <h3>${event.title}</h3>
                        <p>${new Date(event.start_time).toLocaleDateString()} • ${event.venue}</p>
                    </div>
                `;

                card.addEventListener('click', () => {
                    if (eventGrid) eventGrid.classList.add('hidden');
                    if (ticketSection) ticketSection.classList.remove('hidden');
                    
                    document.getElementById('venue-name').textContent = `${event.title} • ${event.venue}`;
                    renderDynamicSeats(event.id); 
                });

                if (eventGrid) eventGrid.appendChild(card);
            });
        } catch (error) {
            console.error('Error loading events:', error);
            if (eventGrid) eventGrid.innerHTML = '<p style="color:red;">Failed to load events. Is your backend running?</p>';
        }
    }

    loadEvents(); // Load immediately on page open

    // ==========================================
    // 2. Navigation
    // ==========================================
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            if (ticketSection) ticketSection.classList.add('hidden');
            if (eventGrid) eventGrid.classList.remove('hidden');
            document.getElementById('seat-map').innerHTML = ''; 
        });
    }

    // ==========================================
    // 3. Dynamic Search Logic
    // ==========================================
    if (searchBtn && searchInput) {
        searchBtn.addEventListener('click', async () => {
            const keyword = searchInput.value.trim();
            if (!keyword) return alert('Please enter an artist or event name.');

            const originalText = searchBtn.textContent;
            searchBtn.textContent = 'Searching...';
            if (eventGrid) eventGrid.innerHTML = '<p style="color: white; text-align: center; width: 100%; margin-top: 50px;">Fetching live data from Ticketmaster...</p>';

            try {
                // Fetch new events
                const searchRes = await fetch(`/api/search?keyword=${encodeURIComponent(keyword)}`);
                const searchData = await searchRes.json();

                if (!searchRes.ok) {
                    alert(searchData.error || 'No events found.');
                    searchBtn.textContent = originalText;
                    loadEvents();
                    return;
                }

                // Build new seats for the new events
                await fetch('/api/generate-seats');

                // Reload the grid
                await loadEvents();
            } catch (error) {
                console.error('Search failed:', error);
                alert('An error occurred. Make sure your server is running.');
            } finally {
                searchBtn.textContent = originalText;
                searchInput.value = '';
            }
        });
    }
}); // End of DOMContentLoaded

// ==========================================
// 4. Dynamic Seat Engine
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

                seatEl.addEventListener('click', async () => {
                const storedUser = localStorage.getItem('currentUser');
                if (!storedUser) {
                    alert('Please sign in first to purchase tickets!');
                    return;
                }
                const user = JSON.parse(storedUser);

                // 1. Request Redis Lock
                try {
                    const lockRes = await fetch('/api/seats/lock', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ seat_id: seat.id, user_id: user.email })
                    });
                    const lockData = await lockRes.json();

                    if (!lockRes.ok) {
                        alert(lockData.error);
                        return;
                    }

                    // 2. Open Checkout Modal
                    const checkoutModal = document.getElementById('checkout-modal');
                    checkoutModal.style.display = 'flex';
                    checkoutModal.classList.remove('hidden');
                    document.getElementById('checkout-seat-details').textContent = `Seat: ${seat.section} • ${seat.row} - Seat ${seat.seat_number}`;

                    // Handle Confirm Payment
                    const confirmBtn = document.getElementById('confirm-pay-btn');
                    const newConfirmBtn = confirmBtn.cloneNode(true);
                    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

                    newConfirmBtn.addEventListener('click', async () => {
                            const msg = document.getElementById('checkout-message');
                            msg.textContent = 'Processing secure payment...';
                            msg.style.color = '#999';

                            // Grab the current event title safely from the DOM
                            const currentEventTitle = document.getElementById('venue-name')?.textContent.split('•')[0].trim() || 'Live Concert';

                            try {
                                const payRes = await fetch('/api/checkout', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        seat_id: seat.id,
                                        user_email: user.email,
                                        price: 150000,
                                        event_name: currentEventTitle
                                    })
                                });

                                const payData = await payRes.json();
                                if (payRes.ok) {
                                    msg.textContent = '✅ Payment successful!';
                                    msg.style.color = '#4CAF50';
                                    setTimeout(() => {
                                        checkoutModal.style.display = 'none';
                                        checkoutModal.classList.add('hidden');
                                        renderDynamicSeats(eventId);
                                    }, 1500);
                                } else {
                                    msg.textContent = `❌ ${payData.error || 'Payment failed'}`;
                                    msg.style.color = '#f44336';
                                }
                            } catch (fetchErr) {
                                console.error('Fetch error:', fetchErr);
                                msg.textContent = '❌ Network error.';
                                msg.style.color = '#f44336';
                            }
                        });

                    // Handle Cancel
                    document.getElementById('checkout-cancel-btn').onclick = () => {
                        checkoutModal.style.display = 'none';
                        checkoutModal.classList.add('hidden');
                    };

                } catch (err) {
                    console.error('Lock error:', err);
                    alert('Could not connect to server for seat locking.');
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

// ==========================================
// 5. TRANSFER & WALLET LOGIC
// ==========================================
const navMyTicketsBtn = document.getElementById('nav-my-tickets');
const walletSection = document.getElementById('my-tickets-section');
const mainGrid = document.getElementById('dynamic-event-grid');
const transferModal = document.getElementById('transfer-modal');

// Open the Wallet
// Open / Close the Modal
document.getElementById('open-transfer-btn')?.addEventListener('click', () => {
    transferModal.style.display = 'flex';
    transferModal.classList.remove('hidden');
});
document.getElementById('close-modal-btn')?.addEventListener('click', () => {
    transferModal.style.display = 'none';
    transferModal.classList.add('hidden');
    document.getElementById('transfer-message').textContent = '';
});

// Actually Send the Email
document.getElementById('submit-transfer-btn')?.addEventListener('click', async () => {
    const email = document.getElementById('friend-email').value;
    const senderName = document.getElementById('transfer-sender-name').value || 'Rowland Joshua'; // Fallback to your name!
    const eventName = document.getElementById('transfer-event-name').value || 'Live Event';
    const seatInfo = document.getElementById('transfer-seat-info').value || 'General Admission';
    const msg = document.getElementById('transfer-message');
    
    if (!email) {
        msg.textContent = 'Please enter an email!';
        msg.style.color = '#f44336';
        return;
    }

    msg.textContent = 'Generating secure link and sending email...';
    msg.style.color = '#999';

    try {
        const response = await fetch('/api/tickets/transfer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                ticket_id: 1, 
                owner_id: senderName, // Passing your typed name here!
                recipient_email: email,
                event_name: eventName,
                seat_info: seatInfo
            })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            msg.textContent = '✅ Success! Email sent.';
            msg.style.color = '#4CAF50';
        } else {
            msg.textContent = `❌ ${data.error}`;
            msg.style.color = '#f44336';
        }
    } catch (error) {
        msg.textContent = 'Server connection failed.';
        msg.style.color = '#f44336';
    }
});

// ==========================================
// 6. AUTHENTICATION & LOGIN UI LOGIC
// ==========================================
const authModal = document.getElementById('auth-modal');
const navSigninBtn = document.getElementById('nav-signin-btn');
const authCloseBtn = document.getElementById('auth-close-btn');
const authSwitchMode = document.getElementById('auth-switch-mode');
const authTitle = document.getElementById('auth-title');
const authNameInput = document.getElementById('auth-name');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const authMessage = document.getElementById('auth-message');

let isRegistering = false; // Default mode is Sign In

// Open Modal
if (navSigninBtn) {
    navSigninBtn.addEventListener('click', (e) => {
        e.preventDefault();
        authModal.style.display = 'flex';
        authModal.classList.remove('hidden');
    });
}

// Close Modal
if (authCloseBtn) {
    authCloseBtn.addEventListener('click', () => {
        authModal.style.display = 'none';
        authModal.classList.add('hidden');
        authMessage.textContent = '';
    });
}

// Switch between Login and Register mode
if (authSwitchMode) {
    authSwitchMode.addEventListener('click', () => {
        isRegistering = !isRegistering;
        if (isRegistering) {
            authTitle.textContent = 'Create an Account';
            authNameInput.classList.remove('hidden');
            authSubmitBtn.textContent = 'Register';
            authSwitchMode.textContent = 'Sign In';
            authSwitchMode.previousElementSibling.textContent = 'Already have an account? ';
        } else {
            authTitle.textContent = 'Sign In to MyuzeTix';
            authNameInput.classList.add('hidden');
            authSubmitBtn.textContent = 'Sign In';
            authSwitchMode.textContent = 'Register';
            authSwitchMode.previousElementSibling.textContent = "Don't have an account? ";
        }
        authMessage.textContent = '';
    });
}

// Submit Login or Registration
if (authSubmitBtn) {
    authSubmitBtn.addEventListener('click', async () => {
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value.trim();
        const name = authNameInput.value.trim();

        if (!email || !password || (isRegistering && !name)) {
            authMessage.textContent = 'Please fill in all fields.';
            authMessage.style.color = '#f44336';
            return;
        }

        authMessage.textContent = 'Processing...';
        authMessage.style.color = '#999';

        const endpoint = isRegistering ? '/api/auth/register' : '/api/auth/login';
        const payload = isRegistering ? { name, email, password } : { email, password };

        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await res.json();

            if (res.ok) {
                authMessage.textContent = `✅ ${data.message}`;
                authMessage.style.color = '#4CAF50';

                // Save user session in browser local storage
                localStorage.setItem('currentUser', JSON.stringify(data.user));

                setTimeout(() => {
                    authModal.style.display = 'none';
                    authModal.classList.add('hidden');
                    window.location.reload(); // Refresh to reflect logged-in state
                }, 1000);
            } else {
                authMessage.textContent = `❌ ${data.error}`;
                authMessage.style.color = '#f44336';
            }
        } catch (err) {
            console.error('Auth error:', err);
            authMessage.textContent = 'Server connection failed.';
            authMessage.style.color = '#f44336';
        }
    });
}

// ==========================================
// 7. NAVBAR USER STATE DISPLAY
// ==========================================
function checkUserSession() {
    const navLinksContainer = document.getElementById('nav-links-container');
    const storedUser = localStorage.getItem('currentUser');

    if (storedUser && navLinksContainer) {
        const user = JSON.parse(storedUser);

        // Replace the sign-in button with a welcome message and logout button
        navLinksContainer.innerHTML = `
            <a href="#" id="nav-my-tickets">My Tickets</a>
            <span style="color: white; font-weight: 600; font-size: 14px;">Hi, ${user.name}</span>
            <a href="#" id="nav-logout-btn" style="color: #f44336; font-weight: bold;">Logout</a>
        `;

        // Re-attach listener for My Tickets to FETCH from PostgreSQL
        document.getElementById('nav-my-tickets')?.addEventListener('click', async () => {
            document.getElementById('dynamic-event-grid')?.classList.add('hidden');
            document.getElementById('ticket-purchasing')?.classList.add('hidden');
            
            const walletSection = document.getElementById('my-tickets-section');
            walletSection.classList.remove('hidden');

            try {
                const res = await fetch(`/api/user/tickets?email=${encodeURIComponent(user.email)}`);
                const tickets = await res.json();
                
                // 1. ADD THE BACK BUTTON DIRECTLY INTO THE WALLET HTML
                let ticketsHtml = `
                    <button id="wallet-back-btn" style="background: #333; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin-bottom: 20px; font-weight: bold;">← Back to Events</button>
                    <h2 style="color:white; margin-bottom: 20px;">My Digital Wallet</h2>
                `;
                
                if (!Array.isArray(tickets) || tickets.length === 0) {
                    ticketsHtml += '<p style="color: #aaa; margin-top: 20px;">You do not own any tickets yet. Complete a checkout first!</p>';
                } else {
                    ticketsHtml += '<div style="display: flex; flex-wrap: wrap; gap: 20px;">';
                    tickets.forEach(ticket => {
                        ticketsHtml += `
                            <div style="background-color: #1a1a1f; padding: 25px; border-radius: 8px; border-left: 5px solid #026cdf; width: 320px; display: inline-block; box-shadow: 0 4px 15px rgba(0,0,0,0.3); color: white;">
                                <h3 style="margin-top: 0; color: white; font-size: 18px;">${ticket.event_name || 'Verified Ticket'}</h3>
                                <p style="color: #999; margin: 8px 0; font-size: 14px;">Ticket ID: #${ticket.id} • Status: <span style="color: #4CAF50; font-weight: bold;">${ticket.status}</span></p>
                                <p style="color: #ccc; margin: 8px 0; font-size: 14px;">Price Paid: ₦${Number(ticket.price || 150000).toLocaleString()}</p>
                                <button onclick="openTransferModal(${ticket.id})" style="background-color: #026cdf; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold; margin-top: 15px; font-size: 13px;">Transfer to Friend</button>
                            </div>
                        `;
                    });
                    ticketsHtml += '</div>';
                }
                walletSection.innerHTML = ticketsHtml;

                // 2. ATTACH THE CLICK LISTENER IMMEDIATELY AFTER ADDING THE BUTTON TO HTML
                document.getElementById('wallet-back-btn')?.addEventListener('click', () => {
                    walletSection.classList.add('hidden');
                    document.getElementById('dynamic-event-grid')?.classList.remove('hidden');
                });

            } catch (err) {
                console.error('Wallet error:', err);
                walletSection.innerHTML = '<h2 style="color:white;">My Digital Wallet</h2><p style="color:#f44336;">Failed to load your tickets.</p>';
            }
        });

        // Logout functionality
        document.getElementById('nav-logout-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            localStorage.removeItem('currentUser');
            window.location.reload(); // Reset page back to guest state
        });
    }
}

// Run this check immediately when the page loads
checkUserSession();

// ==========================================
// TICKET TRANSFER FUNCTIONALITY
// ==========================================

// Create transfer modal HTML if it doesn't exist
if (!document.getElementById('transfer-modal')) {
    const modalHTML = `
        <div id="transfer-modal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; justify-content: center; align-items: center;">
            <div style="background: #1a1a1f; padding: 40px; border-radius: 10px; max-width: 500px; color: white; box-shadow: 0 10px 40px rgba(0,0,0,0.5);">
                <h2 style="color: #026cdf; margin-top: 0;">Transfer Ticket to Friend</h2>
                <p style="color: #aaa;">Enter your friend's email to transfer this ticket</p>
                
                <input type="email" id="transfer-recipient-email" placeholder="Friend's Email Address" style="width: 100%; padding: 12px; margin: 15px 0; border: none; border-radius: 4px; background: #333; color: white; font-size: 14px;" />
                
                <div style="display: flex; gap: 10px; margin-top: 25px;">
                    <button onclick="closeTransferModal()" style="flex: 1; padding: 12px; background: #333; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Cancel</button>
                    <button onclick="submitTransfer()" style="flex: 1; padding: 12px; background: #026cdf; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Send Ticket</button>
                </div>
                <p id="transfer-status" style="color: #f44336; text-align: center; margin-top: 15px; display: none;"></p>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

// Store current ticket being transferred
let currentTransferTicketId = null;

function openTransferModal(ticketId) {
    currentTransferTicketId = ticketId;
    const modal = document.getElementById('transfer-modal');
    if (modal) {
        modal.style.display = 'flex';
        document.getElementById('transfer-recipient-email').value = '';
        document.getElementById('transfer-status').style.display = 'none';
        document.getElementById('transfer-status').textContent = '';
    }
}

function closeTransferModal() {
    const modal = document.getElementById('transfer-modal');
    if (modal) {
        modal.style.display = 'none';
    }
    currentTransferTicketId = null;
}

async function submitTransfer() {
    const recipientEmail = document.getElementById('transfer-recipient-email').value.trim();
    const statusEl = document.getElementById('transfer-status');
    
    if (!recipientEmail || !recipientEmail.includes('@')) {
        statusEl.textContent = '❌ Please enter a valid email address';
        statusEl.style.display = 'block';
        return;
    }
    
    if (!currentTransferTicketId) {
        statusEl.textContent = '❌ No ticket selected';
        statusEl.style.display = 'block';
        return;
    }

    try {
        const currentUser = JSON.parse(localStorage.getItem('currentUser'));
        const ownerEmail = currentUser?.email || 'Unknown User';
        const ownerName = currentUser?.name || 'A Friend';

        // Get current user and event info from the wallet display
        const response = await fetch(`/api/user/tickets?email=${encodeURIComponent(ownerEmail)}`);
        const tickets = await response.json();
        const ticketData = tickets.find(t => t.id === currentTransferTicketId);

        if (!ticketData) {
            statusEl.textContent = '❌ Ticket not found';
            statusEl.style.display = 'block';
            return;
        }

        const transferRes = await fetch('/api/tickets/transfer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticket_id: currentTransferTicketId,
                owner_id: ownerName,
                recipient_email: recipientEmail,
                event_name: ticketData.event_name || 'Live Event',
                seat_info: ticketData.seat_id ? `Seat #${ticketData.seat_id}` : 'General Admission'
            })
        });

        const result = await transferRes.json();

        if (transferRes.ok) {
            statusEl.textContent = '✅ Ticket transfer initiated! Check your friend\'s email.';
            statusEl.style.color = '#4CAF50';
            statusEl.style.display = 'block';
            
            setTimeout(() => {
                closeTransferModal();
                // Reload wallet to update ticket status
                document.getElementById('nav-wallet-btn')?.click();
            }, 2000);
        } else {
            statusEl.textContent = `❌ ${result.error || 'Transfer failed'}`;
            statusEl.style.display = 'block';
        }
    } catch (err) {
        console.error('Transfer error:', err);
        statusEl.textContent = '❌ An error occurred. Please try again.';
        statusEl.style.display = 'block';
    }
}
