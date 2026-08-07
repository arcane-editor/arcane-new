import { URI } from 'monaco-editor/esm/vs/base/common/uri.js';
const cases = [
  'file://D%3A/x/y.cs',
  'file://D%3A/Unity/Private%20Investigator/Assets/A.cs',
  'file:///Users/me/A.cs',
  'file:///Users/me/My%20Proj/A.cs',
  'file:///D:/x/y.cs',
  'file://server/share/A.cs',
];
for (const c of cases) {
  const u = URI.parse(c);
  console.log(JSON.stringify(c));
  console.log('   auth=' + JSON.stringify(u.authority), 'path=' + JSON.stringify(u.path));
  console.log('   toString()=', u.toString(), ' | toString(true)=', u.toString(true));
}
