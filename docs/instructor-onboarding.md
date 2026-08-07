# Instructor Onboarding Guide

This guide explains how to onboard new instructors using the interactive CLI tool.

## Prerequisites

Before onboarding a new instructor, you'll need the following information:

- **WhatsApp Phone Number ID** - From Meta Developer Dashboard
- **Personal Phone Number** - For OAuth flow (optional)
- **Instructor Name** - Full name
- **Email** - Contact email
- **Google Calendar ID** - Usually the same as email
- **Google OAuth Refresh Token** - From OAuth flow
- **WhatsApp Access Token** - From Meta Developer Dashboard
- **Google Spreadsheet ID** - Optional, for booking tracking
- **Base Location** - Latitude and longitude coordinates
- **Timezone** - IANA timezone (e.g., Europe/London)

## Getting OAuth Tokens

### Google OAuth Refresh Token

1. Run the server and use the OAuth flow:
   ```
   npm run dev
   ```
2. Navigate to: `http://localhost:3000/auth/google?phone=<instructor_phone>`
3. Complete the Google OAuth flow
4. The refresh token will be automatically saved to the instructor's record

### WhatsApp Access Token

1. Go to Meta Developer Dashboard
2. Select your WhatsApp app
3. Navigate to WhatsApp > Configuration
4. Generate a temporary or permanent access token
5. Copy the token (starts with `EAA`...)

## Using the Instructor CLI

### Add a New Instructor

```bash
npm run instructor:add
# or
node scripts/seedInstructor.js add
```

You'll be prompted for all required information interactively. Password fields (tokens) are hidden.

### List All Instructors

```bash
npm run instructor:list
# or
node scripts/seedInstructor.js list
```

Displays a table of all instructors with their key information.

### Update an Existing Instructor

```bash
npm run instructor:update
# or
node scripts/seedInstructor.js update
```

Select an instructor from the list, then update any fields interactively.

### Delete an Instructor

```bash
npm run instructor:delete
# or
node scripts/seedInstructor.js delete
```

Select an instructor from the list and confirm deletion.

## Onboarding Workflow

1. **Add instructor** with basic info (can leave tokens as placeholders initially)
2. **Get Google OAuth token** via the OAuth flow using `/auth/google?phone=<phone>`
3. **Update instructor** to add the WhatsApp access token
4. **Verify** the instructor is active and all tokens are set

## Validation

The CLI includes validation for:
- Email format
- Phone number format (optional)
- Latitude/longitude coordinates

## Common Issues

### Duplicate Phone Number ID
If you try to add an instructor with a Phone Number ID that already exists, use the `update` command instead.

### Missing OAuth Token
If the Google refresh token is missing, the instructor won't be able to sync their calendar. Use the OAuth flow to generate it.

### WhatsApp Token Expiry
WhatsApp tokens expire periodically. The system includes an auto-refresh mechanism that runs every 7 days.
