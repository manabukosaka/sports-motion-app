const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.resolveRequest = (context, name, platform) => {
  if (name.startsWith(".") && name.endsWith(".js")) {
    // NodeNext imports name the emitted file. Metro also needs to find the source file.
    try {
      return context.resolveRequest(context, name, platform);
    } catch (error) {
      if (error.constructor.name !== "FailedToResolvePathError") throw error;
      return context.resolveRequest(context, name.slice(0, -3), platform);
    }
  }
  return context.resolveRequest(context, name, platform);
};

module.exports = config;
