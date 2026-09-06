import { searchProducts, Product } from '../agent/tools/shopping.js';

async function runTests() {
  console.log('Running Deterministic Shopping Tool Unit Tests...\n');

  // TEST 1: Headphones under $200
  console.log('Test 1: Find headphones under $200 (delay 0ms for fast test)');
  const res1 = await searchProducts({ category: 'headphones', max_price: 200, delayMs: 0 });
  console.log(`Matched: ${res1.products.length} products`);
  res1.products.forEach((p: Product) => console.log(` - ${p.name} ($${p.price})`));
  const test1Pass = res1.products.every((p: Product) => p.category === 'headphones' && p.price <= 200);
  console.log(`Test 1 Passed: ${test1Pass}\n`);

  // TEST 2: Bose headphones
  console.log('Test 2: Find Bose headphones');
  const res2 = await searchProducts({ category: 'headphones', brand: 'Bose', delayMs: 0 });
  console.log(`Matched: ${res2.products.length} products`);
  res2.products.forEach((p: Product) => console.log(` - ${p.name} ($${p.price})`));
  const test2Pass = res2.products.every((p: Product) => p.category === 'headphones' && p.brand === 'Bose');
  console.log(`Test 2 Passed: ${test2Pass}\n`);

  // TEST 3: Laptops under $1000
  console.log('Test 3: Find laptops under $1000');
  const res3 = await searchProducts({ category: 'laptops', max_price: 1000, delayMs: 0 });
  console.log(`Matched: ${res3.products.length} products`);
  res3.products.forEach((p: Product) => console.log(` - ${p.name} ($${p.price}, ${p.ram_gb}GB RAM)`));
  const test3Pass = res3.products.every((p: Product) => p.category === 'laptops' && p.price <= 1000);
  console.log(`Test 3 Passed: ${test3Pass}\n`);

  // TEST 4: Laptops under $800 with 16GB RAM
  console.log('Test 4: Find laptops under $800 with 16GB RAM');
  const res4 = await searchProducts({ category: 'laptops', max_price: 800, min_ram_gb: 16, delayMs: 0 });
  console.log(`Matched: ${res4.products.length} products`);
  res4.products.forEach((p: Product) => console.log(` - ${p.name} ($${p.price}, ${p.ram_gb}GB RAM)`));
  const test4Pass = res4.products.every((p: Product) => p.category === 'laptops' && p.price <= 800 && (p.ram_gb ?? 0) >= 16);
  console.log(`Test 4 Passed: ${test4Pass}\n`);

  // TEST 5: Verify default ~4000ms delay
  console.log('Test 5: Verify artificial delay (~1000ms controlled test)');
  const start = Date.now();
  await searchProducts({ category: 'headphones', delayMs: 1000 });
  const elapsed = Date.now() - start;
  console.log(`Elapsed time: ${elapsed}ms (expected >= 1000ms)`);
  const test5Pass = elapsed >= 950;
  console.log(`Test 5 Passed: ${test5Pass}\n`);

  if (test1Pass && test2Pass && test3Pass && test4Pass && test5Pass) {
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
  } else {
    throw new Error('Some tests failed!');
  }
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});

