const SOURCES = new Set(['MYSQL_PASSWORD', 'MYSQL_PASSWORDS_JSON']);
export function normalizePasswordReference(name, input) {
  const passwordSource = input.passwordSource ?? 'MYSQL_PASSWORD';
  if (!SOURCES.has(passwordSource)) throw new Error('密码来源只能是 MYSQL_PASSWORD 或 MYSQL_PASSWORDS_JSON。');
  const passwordKey = input.passwordKey ?? name;
  if (typeof passwordKey !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(passwordKey) || ['__proto__','constructor','prototype'].includes(passwordKey)) {
    throw new Error('密码名称只能使用字母、数字、下划线和连字符，长度不超过 64。');
  }
  return { passwordSource, passwordKey };
}
export function environmentPassword(name, connection, env = process.env) {
  const {passwordSource, passwordKey} = normalizePasswordReference(name, connection);
  if (passwordSource === 'MYSQL_PASSWORD') return typeof env.MYSQL_PASSWORD === 'string' && env.MYSQL_PASSWORD.length ? env.MYSQL_PASSWORD : null;
  if (!env.MYSQL_PASSWORDS_JSON) return null;
  let values;
  try { values = JSON.parse(env.MYSQL_PASSWORDS_JSON); }
  catch { throw new Error('MYSQL_PASSWORDS_JSON 格式无效；环境变量内容不会输出。'); }
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some(v => typeof v !== 'string')) {
    throw new Error('MYSQL_PASSWORDS_JSON 必须是名称到密码字符串的 JSON 对象；内容不会输出。');
  }
  return Object.hasOwn(values,passwordKey) && values[passwordKey].length ? values[passwordKey] : null;
}
