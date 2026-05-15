require('dotenv').config();
const app  = require('./app');
const PORT = process.env.PORT || 3000;

// Defense in depth: in Node 20+, an unhandled promise rejection terminates
// the process by default. A single un-awaited DB error inside a route handler
// would otherwise crash the whole server (see the `/api/reviews` ECONNREFUSED
// crash that motivated this). Log loudly but keep serving — clients receive a
// stalled request rather than the entire app going down on the next click.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

app.listen(PORT, () => {
  console.log(`🥚 Sakinah Ridge Farm LLC running at http://localhost:${PORT}`);
});

