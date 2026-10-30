// Node native-addon ABI boundary, replaced by the unchanged upstream cache mock.
exports.showNotification = () => {
  throw new Error("Native addon not available in Node transport")
}
