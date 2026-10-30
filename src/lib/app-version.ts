import metadata from "../../package.json" with { type: "json" }
export const getVersion = () => metadata.version
