const fs = require('fs');
const glob = require('glob');
glob.sync('tests/**/*.ts').concat(glob.sync('scratch/**/*.ts')).concat(glob.sync('src/legacy/**/*.ts')).forEach(f => {
  let c = fs.readFileSync(f, 'utf8');
  c = c.replace(/..\/src\/application\/(CycleEvaluator|ArbitrageMathEngine|ArbitrageCycle|CycleExecutor|TriangularPairs)/g, "../src/legacy/$1");
  c = c.replace(/..\/..\/src\/application\/(CycleEvaluator|ArbitrageMathEngine|ArbitrageCycle|CycleExecutor|TriangularPairs)/g, "../../src/legacy/$1");
  c = c.replace(/..\/application\/(CycleEvaluator|ArbitrageMathEngine|ArbitrageCycle|CycleExecutor|TriangularPairs)/g, "./$1");
  fs.writeFileSync(f, c);
});
