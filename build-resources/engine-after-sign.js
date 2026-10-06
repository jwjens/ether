// electron-builder `afterSign` hook — see engine-pack.js (Windows: the HA helper must be validly signed).
module.exports = require("./engine-pack").afterSign;
