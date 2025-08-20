// utils/dateTimeUtils.js
class DateTimeUtils {
  static sanitize(dateTimeInfo, pendingContext) {
    const updated = { ...dateTimeInfo };

    if (!updated.explicitDate && updated.time && pendingContext?.date) {
      // console.log("Case 1: Time was given but NOT an explicit date → use pending date");
      updated.date = pendingContext.date;
    }

    else if (!updated.explicitTime && updated.date && pendingContext?.time) {
      // console.log("Case 2: Date was given but NOT an explicit time → use pending time");
      updated.time = pendingContext.time;
    }

    else if (!updated.explicitDate && !updated.explicitTime && pendingContext) {
      // console.log("Case 3: Neither date nor time were explicit → fall back to pending context");
      if (pendingContext.date) updated.date = pendingContext.date;
      if (pendingContext.time) updated.time = pendingContext.time;
    }

    return updated;
  }
}

module.exports = DateTimeUtils;