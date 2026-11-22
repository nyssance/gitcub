// Resolve through the package's canonical addon path so the upstream test's
// require.cache mock replaces the same module that the adapted production
// wrapper loads.
module.exports = require("desktop-notifications/build/Release/desktop-notifications.node")
