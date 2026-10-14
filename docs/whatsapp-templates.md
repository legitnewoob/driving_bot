# WhatsApp message templates

WhatsApp only lets Donna send free-form messages within **24 hours of the learner's last message**. Reminders and waiting-list offers often go out after that, so they need **Meta-approved templates**.

Submit these in **Meta Business Manager → WhatsApp Manager → Message templates**. Approval usually takes 1–2 days. Once a template is approved, set its name in the backend environment.

Until then, the bot still sends reminders and offers to learners who messaged in the last 24 hours, as normal button messages. Everyone else is skipped and logged.

| Env var | Used for |
|---|---|
| `WHATSAPP_REMINDER_TEMPLATE` | Reminder ~24h before a lesson |
| `WHATSAPP_SHORT_REMINDER_TEMPLATE` | Reminder ~2h before (only if the instructor picks "24h + 2h") |
| `WHATSAPP_SLOT_OFFER_TEMPLATE` | Offering a cancelled slot to someone on the waiting list |
| `WHATSAPP_TEMPLATE_LANG` | Template language code, default `en_GB` |

Keep the variables (`{{1}}`, `{{2}}`, …) and the button order exactly as below. The bot fills them in that order.

---

## 1. `lesson_reminder`

- **Category:** Utility
- **Language:** English (UK)
- **Body:**

  > Hi! Just a reminder that your driving lesson with {{1}} is on {{2}} at {{3}}. Pickup: {{4}}. Can you still make it?

  Sample values: `Sam` · `Tuesday 14 October` · `10:00` · `ST5 1AB`
- **Buttons (Quick reply, in this order):**
  1. `I'll be there`
  2. `Reschedule`
  3. `Cancel`

## 2. `lesson_reminder_short`

- **Category:** Utility
- **Language:** English (UK)
- **Body:**

  > See you soon! Your lesson with {{1}} starts at {{2}}. Pickup: {{3}}.

  Sample values: `Sam` · `10:00` · `ST5 1AB`
- **Buttons:** none

## 3. `lesson_slot_offer`

- **Category:** Utility
- **Language:** English (UK)
- **Body:**

  > Good news! A lesson with {{1}} has just opened up on {{2}} at {{3}}. Would you like it? The first person to reply gets it.

  Sample values: `Sam` · `Tue 14 Oct` · `10:00`
- **Buttons (Quick reply, in this order):**
  1. `Book it`
  2. `No thanks`

---

Example `.env` once approved:

```
WHATSAPP_REMINDER_TEMPLATE=lesson_reminder
WHATSAPP_SHORT_REMINDER_TEMPLATE=lesson_reminder_short
WHATSAPP_SLOT_OFFER_TEMPLATE=lesson_slot_offer
WHATSAPP_TEMPLATE_LANG=en_GB
```
