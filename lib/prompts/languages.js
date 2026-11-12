/**
 * Language-specific audit lanes.
 *
 * Every language gets at most four specialized lanes that only look at their
 * own surface. The dispatcher may rename or narrow them, but never adds a fifth.
 */
import { LANGUAGES } from '../constants.js';

const LANES = {
  java: [
    ['cmd', '反序列化与命令执行', '反序列化入口、表达式/模板、ProcessBuilder/Runtime、JNDI、脚本引擎'],
    ['inject', 'SQL 与表达式注入', 'JDBC 拼接、MyBatis ${}、SpEL/OGNL、日志注入、XPath'],
    ['file', '文件与路径', '上传、下载、路径拼接、解压、临时文件、SSRF 到文件协议'],
    ['auth', '认证与越权', '过滤器/拦截器绕过、会话、JWT、IDOR、Actuator 与后台接口'],
  ],
  go: [
    ['cmd', '命令执行', 'os/exec、模板注入、插件加载、CGI、cgo 边界'],
    ['inject', '注入', 'database/sql 拼接、GORM Raw、模板、日志、SSRF'],
    ['file', '文件与路径', 'filepath.Join 穿越、上传、压缩包、静态目录、临时文件'],
    ['auth', '认证与越权', '中间件顺序、JWT、会话、IDOR、调试接口'],
  ],
  python: [
    ['cmd', '命令执行', 'os.system/subprocess、eval/exec、pickle/yaml、SSTI、Django 模板'],
    ['inject', '注入与反序列化', 'ORM raw/extra、SQL 拼接、日志、SSRF、XML'],
    ['file', '文件与路径', 'open/路径拼接、上传、压缩包、静态文件、临时文件'],
    ['auth', '认证与越权', '装饰器遗漏、会话、JWT、IDOR、管理后台与调试模式'],
  ],
  php: [
    ['cmd', '命令执行', 'system/exec/shell_exec、反引号、eval/assert、create_function、回调'],
    ['file', '文件系统', 'include/require、文件读写、上传、phar、解压、临时文件'],
    ['inject', '综合安全', 'SQL 拼接、模板、反序列化、SSRF、XXE、变量覆盖'],
    ['auth', '认证', '会话固定、JWT、越权、后台接口、鉴权绕过'],
  ],
  jsts: [
    ['cmd', '命令执行', 'child_process、eval/Function、vm、模板引擎、原型链到执行'],
    ['inject', '原型链与注入', '原型污染、SQL/NoSQL 拼接、模板、SSRF、路径注入'],
    ['file', '文件与路径', '路径拼接、上传、静态目录、压缩包、临时文件'],
    ['auth', '认证与越权', '中间件顺序、JWT、会话、IDOR、管理接口'],
  ],
  rust: [
    ['cmd', '命令执行', 'Command、unsafe 边界、插件加载、模板'],
    ['inject', '注入', 'SQLx/diesel 拼接、模板、日志、SSRF、反序列化'],
    ['file', '文件与路径', '路径拼接、上传、静态文件、临时文件、符号链接'],
    ['auth', '认证与越权', '中间件、JWT、会话、IDOR、管理接口'],
  ],
  ruby: [
    ['cmd', '命令执行', 'system/exec/backtick、eval、YAML.load、ERB、Rails 序列化'],
    ['inject', '注入与反序列化', 'ActiveRecord 拼接、SQL、模板、SSRF、Marshal'],
    ['file', '文件与路径', '路径拼接、上传、send_file、压缩包、临时文件'],
    ['auth', '认证与越权', 'before_action 遗漏、会话、JWT、IDOR、管理接口'],
  ],
  csharp: [
    ['cmd', '反序列化与命令执行', 'BinaryFormatter/TypeConverter、Process、表达式树、Razor'],
    ['inject', '注入', 'SQL 拼接、Dapper、模板、SSRF、XML'],
    ['file', '文件与路径', '路径拼接、上传、压缩包、静态文件、临时文件'],
    ['auth', '认证与越权', '授权特性遗漏、JWT、会话、IDOR、管理接口'],
  ],
  c: [
    ['mem', '内存破坏', '栈/堆溢出、格式化字符串、整数溢出、UAF、双重释放'],
    ['cmd', '命令执行', 'system/popen/exec、环境变量、动态加载'],
    ['file', '文件与路径', '路径拼接、临时文件、符号链接、权限位'],
    ['auth', '认证与越权', '鉴权逻辑、会话/令牌、权限检查、调试接口'],
  ],
  cpp: [
    ['mem', '内存破坏', '越界、UAF、类型混淆、异常安全、RAII 缺口'],
    ['cmd', '命令执行', 'system/popen/exec、动态加载、模板元编程边界'],
    ['file', '文件与路径', '路径拼接、临时文件、符号链接、权限位'],
    ['auth', '认证与越权', '鉴权逻辑、会话/令牌、权限检查、调试接口'],
  ],
  solidity: [
    ['reent', '重入与外部调用', 'external call、delegatecall、重入、返回值检查'],
    ['auth', '权限控制', 'onlyOwner 遗漏、访问控制、初始化、代理升级'],
    ['logic', '算术与逻辑', '溢出/精度、舍入、时间戳、随机数、循环'],
    ['dep', '依赖与升级', 'oracle、代币兼容、upgradeable 存储布局、外部合约'],
  ],
};

/**
 * Return the default lane set for one language.
 * @param {string} language
 * @returns {{key: string, label: string, focus: string}[]}
 */
export function lanesForLanguage(language) {
  const rows = LANES[language] ?? LANES.jsts;
  return rows.map(([key, label, focus]) => ({ key, label, focus }));
}

/** Human label for a language value. */
export function languageLabel(language) {
  return LANGUAGES.find((entry) => entry.value === language)?.label ?? language;
}
