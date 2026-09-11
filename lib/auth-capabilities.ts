export function isChatGPTLoginEnabled() {
  return process.env.CHATGPT_LOGIN_ENABLED?.trim().toLowerCase() !== "false";
}
