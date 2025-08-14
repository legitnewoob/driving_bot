function getAvailableDates() {
  const dates = [];
  const today = new Date();

  for (let i = 1; i <= 10; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    if (date.getDay() !== 0 && date.getDay() !== 6) {
      dates.push({
        value: date.toISOString().split('T')[0],
        display: date.toLocaleDateString('en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        })
      });
    }
    if (dates.length >= 7) break;
  }

  return dates;
}

module.exports = { getAvailableDates };