// 词法器回归测试：防止正则字面量/注释/模板串再次把字符串提取打乱（历史 bug 曾导致
// 57%~64% 的 bundle 内容对扫描器不可见）。运行：npm run test:scan
import { extractStringLiterals, findBalancedEndSmart } from './lib/workbench-scan-shared.mjs';
import { pruneSubsumedCandidates } from './lib/workbench-patch-extractors.mjs';

const stringCases = [
  // 正则字面量里的引号不应打乱引号配对（历史 bug 的直接元凶）
  ['x.replace(/["\']/g,"");var a={section:"Browser",automation:"Browser Automation"}', ['Browser Automation']],
  // 除法：标识符后的 / 是除号
  ['var a=total/2;label:"OK Done"', ['OK Done']],
  // 控制流括号后的 / 是正则
  ['if(x)/re/.test(s);title:"New Chat"', ['New Chat']],
  // 分组括号后的 / 是除号
  ['var a=(b+c)/2;d="Paren Division"', ['Paren Division']],
  // 行注释与块注释里的引号
  ['// dont " break\nvar b="Help Me"', ['Help Me']],
  ['/* "quoted" */c="Block Comment Test"', ['Block Comment Test']],
  // 模板串嵌套（模板内模板、表达式内字符串）
  ['var t=`a${x`b${"inner str"}`}c`;var d="After Template"', ['After Template']],
  // 正则字符类内的 /
  ['var r=/[/]/;e="Char Class Slash"', ['Char Class Slash']],
  // 正则内转义斜杠
  ['var r=/\\/./;f="Escaped Slash Regex"', ['Escaped Slash Regex']],
  // 撇号在双引号字符串内不应开启单引号串
  ['log("agent\'s subagent tree",s);g="Apostrophe Inside"', ['Apostrophe Inside']],
  // 属性访问后的 in/of 不是关键字，其后的 / 是除号
  ['var v=a.in/2;h="Prop In Division"', ['Prop In Division']],
  // 数字后除法
  ['var n=10/2;m="Number Division"', ['Number Division']],
  // 正则标志
  ['s.replace(/ab/gi,"");n="Regex Flags"', ['Regex Flags']],
  // 含插值的模板串应被丢弃，但其后字符串正常
  ['var u=`hi ${name}`;v="After Interpolation"', ['After Interpolation']],
  // 关键字 return 后的正则
  ['function f(){return/abc/.test(x)}var w="Return Regex"', ['Return Regex']],
  // 逗号后的正则（参数位置）
  ['split(/,/,2);var z="Comma Regex"', ['Comma Regex']],
  // 正则内含双引号与单引号混合
  ['var q=/["\'][^"\']*[\'"]/;var y="Mixed Quotes Regex"', ['Mixed Quotes Regex']]
];

const balanceCases = [
  // 括号配平需跳过正则里的花括号与字符串里的括号
  ['function f(){var r=/[{]/g;var s=")}";return 1}var after="ok"', '{var r=/[{]/g;var s=")}";return 1}'],
  // 模板表达式内的花括号
  ['var o={`k${m({a:1})}`:1};var t=2', '{`k${m({a:1})}`:1}']
];

let failureCount = 0;

for (const [source, expected] of stringCases) {
  const { literals } = extractStringLiterals(source);
  const values = literals.map((literal) => literal.value);
  const missing = expected.filter((value) => !values.includes(value));
  if (missing.length > 0) {
    failureCount += 1;
    console.error(`FAIL 提取缺失 ${JSON.stringify(missing)} :: ${JSON.stringify(source)} => ${JSON.stringify(values)}`);
  } else {
    console.log(`pass ${JSON.stringify(source.slice(0, 52))}`);
  }
}

for (const [source, expectedBlock] of balanceCases) {
  const startIndex = source.indexOf('{');
  const endIndex = findBalancedEndSmart(source, startIndex);
  const actualBlock = endIndex === -1 ? '' : source.slice(startIndex, endIndex + 1);
  if (actualBlock !== expectedBlock) {
    failureCount += 1;
    console.error(`FAIL 配平错误 :: 期望 ${JSON.stringify(expectedBlock)} 实得 ${JSON.stringify(actualBlock)}`);
  } else {
    console.log(`pass balance ${JSON.stringify(source.slice(0, 40))}`);
  }
}

const pruningCandidates = [
  { source: 'label:"Save"' },
  { source: 'panel={label:"Save",description:"Save changes"}' },
  { source: 'description:"Save changes"' },
  { source: 'children:"Save"' }
];
const prunedSources = pruneSubsumedCandidates(pruningCandidates).map(candidate => candidate.source);
const expectedPrunedSources = [
  'panel={label:"Save",description:"Save changes"}',
  'children:"Save"'
];
if (JSON.stringify(prunedSources) !== JSON.stringify(expectedPrunedSources)) {
  failureCount += 1;
  console.error(`FAIL 候选剪枝错误 :: 期望 ${JSON.stringify(expectedPrunedSources)} 实得 ${JSON.stringify(prunedSources)}`);
} else {
  console.log('pass candidate pruning');
}

if (failureCount > 0) {
  console.error(`\n${failureCount} 个用例失败`);
  process.exit(1);
}
console.log('\n全部词法器用例通过');
