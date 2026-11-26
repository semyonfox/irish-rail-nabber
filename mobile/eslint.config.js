const { defineConfig } = require("eslint/config");
const expo = require("eslint-config-expo/flat");

module.exports = defineConfig([{ ignores: ["dist/**", ".expo/**"] }, expo]);
