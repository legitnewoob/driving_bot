const { google } = require('googleapis');
const { oauth2Client } = require('../config/google');
const timezoneUtils = require('../utils/timezoneUtils');
const logger = require('../utils/logger-advanced');
const { notifyInvalidGrant } = require('../utils/emailNotifier');

/**
 * Check if an error is an invalid_grant (expired/revoked refresh token).
 */
function isInvalidGrant(error) {
  const msg = error?.message || '';
  const code = error?.response?.data?.error || '';
  return msg.includes('invalid_grant') || code === 'invalid_grant';
}

class SheetsService {
    constructor() {
        this.sheets = google.sheets({ version: 'v4', auth: oauth2Client });
        this._lastInstructor = null;
    }

    async initializeCredentials(refreshToken) {
        oauth2Client.setCredentials({
            refresh_token: refreshToken
        });
    }

    /**
     * Find a learner's row in the sheet
     * @param {string} spreadsheetId - Google Sheets ID
     * @param {string} phoneNumber - Learner's phone number
     * @returns {Promise<Object>} Row data and index
     */
    async findLearnerRow(spreadsheetId, phoneNumber) {
        try {
            await this.initializeCredentials();

            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId,
                range: 'A:I', // Adjust range based on your columns
            });

            const rows = response.data.values || [];
            
            for (let i = 1; i < rows.length; i++) { // Start from 1 to skip header
                if (rows[i][1] === phoneNumber) { // Phone number is in column B (index 1)
                    return {
                        rowIndex: i + 1, // Google Sheets is 1-indexed
                        data: rows[i],
                        exists: true
                    };
                }
            }

            return { exists: false, nextEmptyRow: rows.length + 1 };
        } catch (error) {
            if (isInvalidGrant(error)) {
                logger.error(`invalid_grant in Sheets findLearnerRow`);
                notifyInvalidGrant(this._lastInstructor || {}, 'Sheets', error.message);
            }
            logger.error(`Error finding learner row: ${error.message}`);
            throw error;
        }
    }

    /**
     * Update or create learner record
     * @param {string} spreadsheetId - Google Sheets ID
     * @param {Object} learnerData - Learner information
     * @param {Object} bookingData - Booking details
     * @param {string} action - 'create', 'update', 'cancel', 'reschedule'
     */
    async updateLearnerRecord(spreadsheetId, learnerData, bookingData, action = 'create', instructor = null) {
        try {
            logger.info(`Sheets: ${action} record for ${learnerData.phoneNumber}`);
            
            if (!spreadsheetId) {
                throw new Error('Spreadsheet ID is required but not provided');
            }

            // Store instructor reference for invalid_grant notifications in sub-calls
            if (instructor) this._lastInstructor = instructor;

            await this.initializeCredentials();

            const learnerRow = await this.findLearnerRow(spreadsheetId, learnerData.phoneNumber);
            
            let rowData;
            let range;

            if (learnerRow.exists) {
                // Update existing learner
                rowData = await this.buildUpdatedRowData(learnerRow.data, bookingData, action);
                range = `A${learnerRow.rowIndex}:I${learnerRow.rowIndex}`;
            } else {
                // Create new learner record
                rowData = await this.buildNewRowData(learnerData, bookingData);
                range = `A${learnerRow.nextEmptyRow}:I${learnerRow.nextEmptyRow}`;
            }

            const response = await this.sheets.spreadsheets.values.update({
                spreadsheetId,
                range,
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: [rowData]
                }
            });

            logger.info(`Sheets updated for ${learnerData.phoneNumber} - Action: ${action}`);
            return response.data;
        } catch (error) {
            if (isInvalidGrant(error)) {
                logger.error(`invalid_grant in Sheets updateLearnerRecord for ${learnerData.phoneNumber}`);
                notifyInvalidGrant(instructor || this._lastInstructor || {}, 'Sheets', error.message);
            }
            logger.error(`Error updating sheets: ${error.message}`);
            throw error;
        }
    }

    /**
     * Build row data for new learner
     */
    async buildNewRowData(learnerData, bookingData) {
        const formattedDate = timezoneUtils.formatDate(
            timezoneUtils.createDateInTimezone(bookingData.date, '12:00'),
            'DD/MM/YYYY'
        );
        const dateTime = `${formattedDate} ${bookingData.time}`;

        return [
            learnerData.name || 'Unknown', // A: learner name
            learnerData.phoneNumber,       // B: phone number  
            learnerData.location || '',    // C: location
            '1',                          // D: lessons had (starting with 1)
            '',                           // E: test booked date days until test (empty initially)
            '',                           // F: xxx (unclear what this field is)
            'Yes',                        // G: lesson booked
            dateTime,                     // H: date/time
            'Confirmed'                   // I: status
        ];
    }

    /**
     * Build updated row data for existing learner
     */
    async buildUpdatedRowData(existingData, bookingData, action) {
        const updatedData = [...existingData];
        
        // Ensure we have at least 9 columns
        while (updatedData.length < 9) {
            updatedData.push('');
        }

        switch (action) {
            case 'create':
            case 'reschedule':
                const formattedDate = timezoneUtils.formatDate(
                    timezoneUtils.createDateInTimezone(bookingData.date || bookingData.newDate, '12:00'),
                    'DD/MM/YYYY'
                );
                const time = bookingData.time || bookingData.newTime;
                const dateTime = `${formattedDate} ${time}`;

                // Increment lesson count for new booking
                if (action === 'create') {
                    const currentLessons = parseInt(updatedData[3]) || 0;
                    updatedData[3] = (currentLessons + 1).toString();
                }

                updatedData[6] = 'Yes';      // G: lesson booked
                updatedData[7] = dateTime;   // H: date/time
                updatedData[8] = action === 'reschedule' ? 'Rescheduled' : 'Confirmed'; // I: status
                break;

            case 'cancel':
                updatedData[6] = 'No';       // G: lesson booked
                updatedData[8] = 'Cancelled'; // I: status
                break;

            case 'complete':
                updatedData[8] = 'Completed'; // I: status
                break;
        }

        return updatedData;
    }

    /**
     * Get instructor's spreadsheet ID from environment or config
     */
    getInstructorSpreadsheetId(instructorId) {
        // Fallback: return env var if instructor record doesn't have one
        const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
        if (!spreadsheetId) {
            logger.warn(`No spreadsheet ID found for instructor ${instructorId}`);
        }
        return spreadsheetId;
    }

    /**
     * Extract learner name from phone or use a default method
     * This is a placeholder - you might want to ask for name during booking
     */
    async getLearnerName(phoneNumber, bookingData) {
        // You could store names in your database, ask during first booking, 
        // or extract from WhatsApp profile if available
        return bookingData.learnerName || `Learner-${phoneNumber.slice(-4)}`;
    }

    /**
     * Batch update multiple cells (useful for multiple bookings)
     */
    async batchUpdate(spreadsheetId, updates) {
        try {
            await this.initializeCredentials();

            const response = await this.sheets.spreadsheets.values.batchUpdate({
                spreadsheetId,
                resource: {
                    valueInputOption: 'USER_ENTERED',
                    data: updates
                }
            });

            return response.data;
        } catch (error) {
            if (isInvalidGrant(error)) {
                logger.error(`invalid_grant in Sheets batchUpdate`);
                notifyInvalidGrant(this._lastInstructor || {}, 'Sheets', error.message);
            }
            logger.error(`Error in batch update: ${error.message}`);
            throw error;
        }
    }
}

module.exports = new SheetsService();