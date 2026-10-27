// waitlistEmails.js
// ─────────────────
// Emails for the launch waitlist and referrals. Written to feel like a note from
// a person: plain layout, one clear action each, no emoji or buttons, so they
// land in Primary rather than Promotions. Everything that isn't a direct answer
// to something they did carries an unsubscribe link; only the launch
// announcement (the one real marketing email) also sends the bulk-mail header.

const { sendNotification, escapeHtml } = require("./emailNotifier");

const fromName = () => process.env.WAITLIST_FROM_NAME || "Raj from Donna Drive";
const site = () => (process.env.FRONTEND_URL || "http://localhost:8080").replace(/\/$/, "");
const api = () => (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const firstName = (name) => escapeHtml(String(name || "").trim().split(/\s+/)[0] || "there");
const longDate = (d) => new Date(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "long", timeZone: "Europe/London" });

const statusUrl = (entry) => `${site()}/waitlist/me?t=${entry.accessToken}`;
const shareUrl = (code) => `${site()}/?ref=${code}`;
const unsubscribeUrl = (entry) => `${api()}/api/waitlist/unsubscribe/${entry.accessToken}`;

function layout(body, entry, { unsubscribe = true } = {}) {
  return `
    <div style="font-family: -apple-system, Segoe UI, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1f2937; font-size: 15px; line-height: 1.6;">
      ${body}
      <p style="margin-top: 28px;">Raj<br/><span style="color:#6b7280;">Donna Drive</span></p>
      ${
        unsubscribe && entry
          ? `<p style="color:#9ca3af; font-size: 12px; margin-top: 28px;">You're getting this because you joined the Donna Drive waitlist.
             <a href="${unsubscribeUrl(entry)}" style="color:#9ca3af;">Unsubscribe</a></p>`
          : ""
      }
    </div>`;
}

// A plain link, not a coloured button: buttons are what newsletters look like,
// and they push the email into Gmail's Promotions tab
const button = (href, label) => `<p style="margin: 20px 0;"><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`;

const unsubscribeHeaders = (entry) => ({
  "List-Unsubscribe": `<${unsubscribeUrl(entry)}>`,
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
});

/** Straight after joining: their place, their link, what happens next. */
async function sendWaitlistConfirmation(entry, { place, launchDate } = {}) {
  const subject = `You're #${place} on the Donna Drive waitlist`;
  const html = layout(
    `
    <p>Hi ${firstName(entry.name)},</p>
    <p>Thanks for joining. You're <strong>#${place}</strong> on the list.</p>
    <p>We're letting instructors in in small batches, so everyone gets their own WhatsApp number and a proper setup.
    ${launchDate ? `We launch on <strong>${longDate(launchDate)}</strong>, and invites go out from then.` : "We'll email you as soon as it's your turn."}</p>
    <p><strong>Want to get in sooner?</strong> Share your link. Every instructor who joins with it moves you up 10 places,
    and if 3 join you're in the next batch. When a friend you referred starts paying, you both get a month free.</p>
    <p>Your link: <a href="${escapeHtml(shareUrl(entry.referralCode))}">${escapeHtml(shareUrl(entry.referralCode))}</a></p>
    ${button(statusUrl(entry), "See your place in the queue")}
    <p>If you have any questions, just reply to this email.</p>
    `,
    entry,
    { unsubscribe: false }
  );
  return sendNotification(subject, html, null, entry.email, null, { fromName: fromName() });
}

/** A friend joined with their link (sent at most once a day). */
async function sendWaitlistMovedUp(entry, { from, to, friendName, referrals }) {
  const subject = `${friendName ? `${String(friendName).split(" ")[0]} joined` : "A friend joined"}. You've moved up to #${to}`;
  const toPriority = Math.max(0, 3 - referrals);
  const html = layout(
    `
    <p>Hi ${firstName(entry.name)},</p>
    <p>${friendName ? `<strong>${escapeHtml(friendName)}</strong>` : "Someone"} joined the waitlist with your link, so you've moved up from #${from} to <strong>#${to}</strong>.</p>
    <p>${
      toPriority === 0
        ? "That's 3 friends, so <strong>you're in the next batch</strong>. Thank you!"
        : `${toPriority} more and you're in the next batch, whatever your place.`
    }</p>
    ${button(statusUrl(entry), "See your place")}
    `,
    entry
  );
  return sendNotification(subject, html, null, entry.email, null, { fromName: fromName() });
}

function inviteBody(entry, { joinUrl, promo, expiresAt, reminder }) {
  return `
    <p>Hi ${firstName(entry.name)},</p>
    <p>${reminder ? "Just a reminder: your invite to Donna Drive is waiting." : "<strong>You're in.</strong> Your spot on Donna Drive is ready."}</p>
    <p>Sign in with Google, pick your plan and start your free trial. Donna will be answering your learners on WhatsApp within minutes.</p>
    ${promo ? `<p><strong>${escapeHtml(promo.label)}</strong> is saved for you. It's applied automatically at checkout.</p>` : ""}
    ${button(joinUrl, reminder ? "Claim your spot" : "Start your free trial")}
    <p>This invite is just for you and works until ${longDate(expiresAt)}. Any questions, just reply.</p>
  `;
}

/** Their turn: a single-use link to sign up. */
async function sendWaitlistInvite(entry, opts) {
  const first = String(entry.name || "").split(" ")[0];
  const subject = first ? `${first}, your Donna Drive invite is ready` : "Your Donna Drive invite is ready";
  return sendNotification(subject, layout(inviteBody(entry, opts), entry, { unsubscribe: false }), null, entry.email, null, { fromName: fromName() });
}

/** One nudge for an invite that hasn't been used. */
async function sendWaitlistReminder(entry, opts) {
  const subject = "Your Donna Drive invite is still waiting";
  return sendNotification(subject, layout(inviteBody(entry, { ...opts, reminder: true }), entry), null, entry.email, null, {
    fromName: fromName(),
  });
}

/** An invite went out by mistake and was taken back: say sorry, they keep their place. */
async function sendInviteApology(entry) {
  const subject = "Sorry, that Donna Drive invite was sent by mistake";
  const html = layout(
    `
    <p>Hi ${firstName(entry.name)},</p>
    <p>Earlier today you got an email inviting you to start using Donna Drive. That was our mistake, and I'm sorry for the mix-up.
    It went out before we were ready, so the link in it won't work.</p>
    <p>You haven't lost anything: you're still on the waitlist, in exactly the same place.</p>
    <p><strong>Stay tuned.</strong> We're going live very soon, and you'll be among the first to hear when your invite is ready (a real one this time).</p>
    <p>Thanks for your patience. If you have any questions, just reply to this email.</p>
    `,
    entry,
    { unsubscribe: false }
  );
  return sendNotification(subject, html, null, entry.email, null, { fromName: fromName() });
}

/** Sign-up is open to everyone (only to people who said yes to product news). */
async function sendLaunchAnnouncement(entry) {
  const subject = "Donna Drive is live";
  const html = layout(
    `
    <p>Hi ${firstName(entry.name)},</p>
    <p>Donna Drive is now open to everyone. Thanks for waiting with us.</p>
    <p>Donna answers your learners on WhatsApp, books lessons around your diary and keeps your calendar up to date, around the clock.</p>
    ${button(`${site()}/?signup=1`, "Start your free trial")}
    `,
    entry
  );
  return sendNotification(subject, html, null, entry.email, null, { fromName: fromName(), headers: unsubscribeHeaders(entry) });
}

/** "Give a month, get a month": a referral started paying. */
async function sendReferralReward({ to, name, friendName, amountLabel, asReferrer }) {
  const subject = asReferrer ? "You've earned a month of Donna Drive" : "Your month of Donna Drive credit";
  const html = layout(
    `
    <p>Hi ${firstName(name)},</p>
    <p>${
      asReferrer
        ? `<strong>${escapeHtml(friendName || "A friend you referred")}</strong> has started paying for Donna Drive, so you've earned a free month.`
        : "Thanks for joining Donna Drive through a friend. As promised, you've both earned a free month."
    }</p>
    <p>We've added <strong>${escapeHtml(amountLabel)}</strong> of credit to your account. It comes off your next payment automatically.</p>
    `,
    null,
    { unsubscribe: false }
  );
  return sendNotification(subject, html, null, to, null, { fromName: fromName() });
}

/** Daily summary for the team. */
async function sendWaitlistDigest({ joined, totals, top }) {
  const subject = `Waitlist: ${joined.length} joined in the last day (${totals.total} total)`;
  const rows = joined
    .slice(0, 50)
    .map((e) => `<tr><td style="padding:4px 8px;">#${e.position}</td><td style="padding:4px 8px;">${escapeHtml(e.name)}</td><td style="padding:4px 8px;">${escapeHtml(e.email)}</td><td style="padding:4px 8px;">${escapeHtml(e.type || "")}</td><td style="padding:4px 8px;">${escapeHtml(e.area || "")}</td></tr>`)
    .join("");
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto;">
      <h2 style="margin:0 0 8px;">Waitlist in the last 24 hours</h2>
      <p>${joined.length} joined · ${totals.total} total · ${totals.waiting} waiting · ${totals.invited} invited · ${totals.joined} signed up</p>
      ${rows ? `<table style="border-collapse:collapse;font-size:13px;">${rows}</table>` : ""}
      ${top.length ? `<p><strong>Top referrers:</strong> ${top.map((t) => `${escapeHtml(t.name)} (${t.referrals})`).join(", ")}</p>` : ""}
      <p><a href="${site()}/admin/waitlist">Open the waitlist</a></p>
    </div>`;
  return sendNotification(subject, html, null, process.env.WAITLIST_DIGEST_TO || null);
}

module.exports = {
  sendWaitlistConfirmation,
  sendWaitlistMovedUp,
  sendWaitlistInvite,
  sendWaitlistReminder,
  sendInviteApology,
  sendLaunchAnnouncement,
  sendReferralReward,
  sendWaitlistDigest,
  statusUrl,
  shareUrl,
};
