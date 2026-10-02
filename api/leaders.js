const fs = require('fs');
const path = require('path');
module.exports = (req, res) => {
  const file = path.join(process.cwd(), 'eval', 'leaderboard.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  res.json(data);
};
