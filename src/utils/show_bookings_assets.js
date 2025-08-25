// // Option 1: Clean card-style format
// async showBookings(from) {
//     const bookings = await bookingService.getBookingsByUser(from);

//     if (!bookings.length) {
//         return whatsappService.sendTextMessage(from, "📭 *No bookings found*\n\nYou don't have any upcoming bookings.");
//     }

//     let message = "*🗓️ YOUR BOOKINGS*\n";
//     message += "━━━━━━━━━━━━━━━━━\n\n";

//     bookings.forEach((booking, index) => {
//         const date = new Date(booking.date);
//         const formattedDate = date.toLocaleDateString('en-US', { 
//             weekday: 'short', 
//             month: 'short', 
//             day: 'numeric' 
//         });
        
//         message += `📌 *Booking ${index + 1}*\n`;
//         message += `📅 ${formattedDate}\n`;
//         message += `⏰ ${booking.time}\n`;
        
//         // Add optional details if available
//         if (booking.service) message += `🎯 ${booking.service}\n`;
//         if (booking.status) message += `📋 Status: ${booking.status}\n`;
        
//         message += "\n";
//     });

//     await whatsappService.sendTextMessage(from, message);
// }

// // Option 2: Compact list with emojis
// async showBookingsCompact(from) {
//     const bookings = await bookingService.getBookingsByUser(from);

//     if (!bookings.length) {
//         return whatsappService.sendTextMessage(from, "📭 *No bookings found*");
//     }

//     let message = "*📋 Your Bookings*\n\n";

//     bookings.forEach((booking, index) => {
//         const date = new Date(booking.date);
//         const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
//         const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        
//         message += `${index + 1}️⃣ ${dayName}, ${dateStr} • ⏰ ${booking.time}\n`;
//     });

//     await whatsappService.sendTextMessage(from, message);
// }

// // Option 3: Timeline style with better spacing
// async showBookingsTimeline(from) {
//     const bookings = await bookingService.getBookingsByUser(from);

//     if (!bookings.length) {
//         return whatsappService.sendTextMessage(from, "📭 *No upcoming bookings*\n\n_Book your next appointment to see it here!_ 📞");
//     }

//     // Sort bookings by date
//     const sortedBookings = bookings.sort((a, b) => new Date(a.date) - new Date(b.date));
    
//     let message = "🗓️ *UPCOMING BOOKINGS*\n";
//     message += "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n\n";

//     sortedBookings.forEach((booking, index) => {
//         const date = new Date(booking.date);
//         const isToday = date.toDateString() === new Date().toDateString();
//         const isTomorrow = date.toDateString() === new Date(Date.now() + 86400000).toDateString();
        
//         let dateLabel;
//         if (isToday) {
//             dateLabel = "🔥 *TODAY*";
//         } else if (isTomorrow) {
//             dateLabel = "⭐ *TOMORROW*";
//         } else {
//             dateLabel = date.toLocaleDateString('en-US', { 
//                 weekday: 'long', 
//                 month: 'long', 
//                 day: 'numeric' 
//             });
//         }
        
//         message += `┌─ 📅 ${dateLabel}\n`;
//         message += `└─ ⏰ ${booking.time}\n`;
        
//         if (index < sortedBookings.length - 1) {
//             message += "│\n";
//         }
//     });

//     message += "\n_Need to make changes? Just let me know!_ 💬";

//     await whatsappService.sendTextMessage(from, message);
// }

// // Option 4: Table-like format
// async showBookingsTable(from) {
//     const bookings = await bookingService.getBookingsByUser(from);

//     if (!bookings.length) {
//         return whatsappService.sendTextMessage(from, "📭 *No bookings yet*\n\nReady to book your first appointment? 🚀");
//     }

//     let message = "*📋 BOOKING SUMMARY*\n";
//     message += "```\n";
//     message += "DATE         TIME    \n";
//     message += "─────────────────────\n";

//     bookings.forEach(booking => {
//         const date = new Date(booking.date);
//         const dateStr = date.toLocaleDateString('en-GB').padEnd(12);
//         const timeStr = booking.time.padEnd(8);
//         message += `${dateStr} ${timeStr}\n`;
//     });

//     message += "```\n";
//     message += `\n📊 Total: *${bookings.length}* booking${bookings.length > 1 ? 's' : ''}`;

//     await whatsappService.sendTextMessage(from, message);
// }