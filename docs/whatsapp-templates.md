# WhatsApp message templates

WhatsApp only lets Donna send free-form messages within **24 hours of the learner's last message**. Reminders and waiting-list offers often go out after that, so they need **Meta-approved templates**.

Submit these in **Meta Business Manager → WhatsApp Manager → Message templates**. Approval usually takes 1–2 days. Once a template is approved, set its name in the backend environment.

Until then, the bot still sends reminders and offers to learners who messaged in the last 24 hours, as normal button messages. Everyone else is skipped and logged.

| Env var | Used for |
|---|---|
| `WHATSAPP_REMINDER_48H_TEMPLATE` | Reminder ~48h before a lesson. Default `lesson_reminder_48h` |
| `WHATSAPP_REMINDER_24H_TEMPLATE` | Reminder ~24h before a lesson. Default `lesson_reminder_24h` |
| `WHATSAPP_REMINDER_TEMPLATE_LANG` | Language of the two reminders above, default `en` |
| `WHATSAPP_SHORT_REMINDER_TEMPLATE` | Reminder ~2h before (only if the instructor picks "24h + 2h") |
| `WHATSAPP_SLOT_OFFER_TEMPLATE` | Offering a cancelled slot to someone on the waiting list |
| `WHATSAPP_TEMPLATE_LANG` | Language of the other templates, default `en_GB` |

The reminder templates are already approved, so they work without setting anything. Set a variable to an empty value to stop using that template.

Keep the variables (`{{1}}`, `{{2}}`, …) and the button order exactly as below. The bot fills them in that order.

---

## 1. `lesson_reminder_48h` and `lesson_reminder_24h` (approved)

- **Category:** Utility
- **Language:** English (`en`)
- **48h body:**

  > Hiya! Just checking in to remind you for your driving lesson with {{1}}. Your scheduled in for {{2}} at {{3}}.
  > Pickup: {{4}}. Let me know if you need to reschedule or make any changes.

- **24h body:**

  > Hi! Just a reminder that your driving lesson with {{1}} is coming up on {{2}} at {{3}}.
  > Pickup: {{4}}. Reply if you need to reschedule.

  Values: instructor name · `Tuesday 14 October` · `10am` · pickup address
- **Buttons:** none. Learners reply in their own words and Donna handles it.

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
WHATSAPP_REMINDER_48H_TEMPLATE=lesson_reminder_48h
WHATSAPP_REMINDER_24H_TEMPLATE=lesson_reminder_24h
WHATSAPP_REMINDER_TEMPLATE_LANG=en
WHATSAPP_SHORT_REMINDER_TEMPLATE=lesson_reminder_short
WHATSAPP_SLOT_OFFER_TEMPLATE=lesson_slot_offer
WHATSAPP_TEMPLATE_LANG=en_GB
```
