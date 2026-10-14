// Runs async tasks one at a time per key (e.g. per learner), in arrival order.
// Different keys run concurrently.
const chains = new Map();

function runExclusive(key, task) {
  const previous = chains.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  chains.set(key, current);
  current
    .catch(() => {})
    .finally(() => {
      if (chains.get(key) === current) chains.delete(key);
    });
  return current;
}

module.exports = { runExclusive };
