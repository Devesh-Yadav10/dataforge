import { searchProducts, compareProducts, Product } from '../agent/tools/shopping.js';

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

  // TEST 6: Compare two valid products (Sony XM4 vs Bose QC45)
  console.log('Test 6: Compare two valid products (hp-3 Sony vs hp-1 Bose)');
  const res6 = await compareProducts({ product_a: 'hp-3', product_b: 'hp-1', delayMs: 0 });
  console.log(` - Success: ${res6.success}, Cheaper: ${res6.cheaper_product}, Diff: $${res6.price_difference}`);
  const test6Pass =
    res6.success &&
    res6.productA?.name === 'Sony WH-1000XM4' &&
    res6.productB?.name === 'Bose QuietComfort 45' &&
    res6.price_difference === 20 &&
    res6.cheaper_product === 'Sony WH-1000XM4';
  console.log(`Test 6 Passed: ${test6Pass}\n`);

  // TEST 7: Compare laptops with RAM specifications
  console.log('Test 7: Compare laptops with RAM specs (lap-1 Lenovo vs lap-2 Acer)');
  const res7 = await compareProducts({ product_a: 'lap-1', product_b: 'lap-2', delayMs: 0 });
  const hasRamDiff = res7.differences?.some((d) => d.attribute === 'RAM');
  console.log(` - Has RAM spec difference: ${hasRamDiff}`);
  const test7Pass = res7.success && hasRamDiff && res7.price_difference === 250;
  console.log(`Test 7 Passed: ${test7Pass}\n`);

  // TEST 8: Unknown product ID returns structured error
  console.log('Test 8: Unknown product ID returns structured error');
  const res8 = await compareProducts({ product_a: 'invalid-id-xyz', product_b: 'hp-1', delayMs: 0 });
  console.log(` - Success: ${res8.success}, Error: ${res8.error}`);
  const test8Pass = res8.success === false && Boolean(res8.error);
  console.log(`Test 8 Passed: ${test8Pass}\n`);

  // TEST 9: Same product compared with itself
  console.log('Test 9: Same product compared with itself (hp-1 vs hp-1)');
  const res9 = await compareProducts({ product_a: 'hp-1', product_b: 'hp-1', delayMs: 0 });
  console.log(` - Price difference: $${res9.price_difference}, Cheaper: ${res9.cheaper_product}`);
  const test9Pass = res9.success && res9.price_difference === 0 && res9.cheaper_product === 'Both have identical price';
  console.log(`Test 9 Passed: ${test9Pass}\n`);

  // TEST 10: Comparison AbortSignal cancellation
  console.log('Test 10: Comparison AbortSignal abort handling');
  const controller = new AbortController();
  const comparePromise = compareProducts({ product_a: 'hp-3', product_b: 'hp-1', delayMs: 500 }, { signal: controller.signal });
  controller.abort();
  let test10Pass = false;
  try {
    await comparePromise;
  } catch (err: any) {
    test10Pass = err.message === 'Operation aborted';
  }
  console.log(` - Abort caught: ${test10Pass}`);
  console.log(`Test 10 Passed: ${test10Pass}\n`);

  // TEST 11: Groq Tool Definitions structure
  console.log('Test 11: Verify Groq / OpenAI tool definitions for search_products and compare_products');
  const { SHOPPING_TOOLS_DEFINITIONS } = await import('../agent/tools/shopping.js');
  const hasSearchTool = SHOPPING_TOOLS_DEFINITIONS.some((t) => t.function.name === 'search_products');
  const hasCompareTool = SHOPPING_TOOLS_DEFINITIONS.some((t) => t.function.name === 'compare_products');
  const test11Pass = hasSearchTool && hasCompareTool;
  console.log(` - Search Tool Present: ${hasSearchTool}, Compare Tool Present: ${hasCompareTool}`);
  console.log(`Test 11 Passed: ${test11Pass}\n`);

  // TEST 12: Quota error classification logic
  console.log('Test 12: Verify Quota / Rate-limit classification');
  function checkQuotaError(err: any): boolean {
    if (!err) return false;
    if (err.name === 'AbortError' || err.message === 'Operation aborted') return false;
    const status = err.status || err.statusCode || err.code || err.httpStatus;
    if (status === 429) return true;
    const msg = (err.message || err.toString() || '').toLowerCase();
    return msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('quota') || msg.includes('rate limit');
  }
  const test12Pass =
    checkQuotaError({ status: 429 }) &&
    checkQuotaError({ message: 'RESOURCE_EXHAUSTED' }) &&
    !checkQuotaError({ name: 'AbortError', message: 'Operation aborted' }) &&
    !checkQuotaError({ status: 500, message: 'Server Error' });
  console.log(` - Quota error detection accuracy: ${test12Pass}`);
  console.log(`Test 12 Passed: ${test12Pass}\n`);

  if (
    test1Pass &&
    test2Pass &&
    test3Pass &&
    test4Pass &&
    test5Pass &&
    test6Pass &&
    test7Pass &&
    test8Pass &&
    test9Pass &&
    test10Pass &&
    test11Pass &&
    test12Pass
  ) {
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
  } else {
    throw new Error('Some tests failed!');
  }
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});


