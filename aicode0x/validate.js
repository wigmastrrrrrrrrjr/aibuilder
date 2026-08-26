const d = require("fs").readFileSync("train_data.jsonl","utf8").trim().split("\n");
d.forEach((l,i) => { try { JSON.parse(l); console.log(i+1, "OK") } catch(e) { console.log(i+1, "FAIL", e.message) } });
console.log("Total:", d.length);
