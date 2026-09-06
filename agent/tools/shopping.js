"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHOPPING_TOOLS_DEFINITIONS = exports.PRODUCTS_CATALOG = void 0;
exports.searchProducts = searchProducts;
exports.PRODUCTS_CATALOG = [
    // Headphones
    {
        id: 'hp-1',
        name: 'Bose QuietComfort 45',
        brand: 'Bose',
        category: 'headphones',
        price: 199,
        description: 'Premium noise-cancelling over-ear headphones with superior comfort.',
    },
    {
        id: 'hp-2',
        name: 'Bose 700 Wireless',
        brand: 'Bose',
        category: 'headphones',
        price: 279,
        description: 'High-end smart noise-cancelling headphones with crystal clear calls.',
    },
    {
        id: 'hp-3',
        name: 'Sony WH-1000XM4',
        brand: 'Sony',
        category: 'headphones',
        price: 179,
        description: 'Industry-leading noise cancellation headphones with 30-hour battery life.',
    },
    {
        id: 'hp-4',
        name: 'Sony WH-1000XM5',
        brand: 'Sony',
        category: 'headphones',
        price: 349,
        description: 'Flagship noise-cancelling wireless headphones with 8 microphones.',
    },
    {
        id: 'hp-5',
        name: 'Apple AirPods Max',
        brand: 'Apple',
        category: 'headphones',
        price: 499,
        description: 'High-fidelity audio with active noise cancellation and transparency mode.',
    },
    {
        id: 'hp-6',
        name: 'Anker Soundcore Life Q30',
        brand: 'Anker',
        category: 'headphones',
        price: 79,
        description: 'Budget-friendly hybrid active noise cancelling headphones.',
    },
    // Laptops
    {
        id: 'lap-1',
        name: 'Lenovo IdeaPad 3',
        brand: 'Lenovo',
        category: 'laptops',
        price: 499,
        ram_gb: 8,
        description: 'Everyday budget laptop with 15.6-inch FHD display and 8GB RAM.',
    },
    {
        id: 'lap-2',
        name: 'Acer Swift Go 14',
        brand: 'Acer',
        category: 'laptops',
        price: 749,
        ram_gb: 16,
        description: 'Slim and lightweight 14-inch laptop with 16GB RAM and fast 512GB SSD.',
    },
    {
        id: 'lap-3',
        name: 'Dell Inspiron 15',
        brand: 'Dell',
        category: 'laptops',
        price: 899,
        ram_gb: 16,
        description: 'Versatile 15.6-inch performance laptop with Intel Core i7 and 16GB RAM.',
    },
    {
        id: 'lap-4',
        name: 'HP Pavilion 15',
        brand: 'HP',
        category: 'laptops',
        price: 699,
        ram_gb: 8,
        description: 'Reliable work laptop with AMD Ryzen 5 and 8GB RAM.',
    },
    {
        id: 'lap-5',
        name: 'Apple MacBook Air M2',
        brand: 'Apple',
        category: 'laptops',
        price: 999,
        ram_gb: 8,
        description: 'Ultra-thin Apple silicon laptop with incredible battery life.',
    },
    {
        id: 'lap-6',
        name: 'Apple MacBook Pro 14 M3',
        brand: 'Apple',
        category: 'laptops',
        price: 1599,
        ram_gb: 18,
        description: 'Pro performance laptop with Liquid Retina XDR display.',
    },
    {
        id: 'lap-7',
        name: 'Lenovo ThinkPad E14',
        brand: 'Lenovo',
        category: 'laptops',
        price: 799,
        ram_gb: 16,
        description: 'Business laptop with durable build, security features, and 16GB RAM.',
    },
    // Phones
    {
        id: 'ph-1',
        name: 'Google Pixel 8a',
        brand: 'Google',
        category: 'phones',
        price: 449,
        ram_gb: 8,
        description: 'AI-powered phone with incredible camera capabilities.',
    },
    {
        id: 'ph-2',
        name: 'Apple iPhone 15',
        brand: 'Apple',
        category: 'phones',
        price: 799,
        ram_gb: 6,
        description: 'Dynamic Island, 48MP main camera, and USB-C.',
    },
    {
        id: 'ph-3',
        name: 'Samsung Galaxy S24',
        brand: 'Samsung',
        category: 'phones',
        price: 799,
        ram_gb: 8,
        description: 'Flagship compact phone with Galaxy AI and vibrant display.',
    },
];
async function searchProducts(params, options) {
    const delay = params.delayMs ?? options?.defaultDelayMs ?? 4000;
    if (delay > 0) {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                resolve();
            }, delay);
            if (options?.signal) {
                options.signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new Error('Operation aborted'));
                }, { once: true });
            }
        });
    }
    const results = exports.PRODUCTS_CATALOG.filter((product) => {
        if (params.category) {
            const cat = params.category.toLowerCase().trim();
            if (!product.category.toLowerCase().includes(cat) && !cat.includes(product.category.toLowerCase())) {
                return false;
            }
        }
        if (params.brand) {
            const brand = params.brand.toLowerCase().trim();
            if (!product.brand.toLowerCase().includes(brand)) {
                return false;
            }
        }
        if (params.max_price !== undefined && params.max_price !== null) {
            if (product.price > params.max_price) {
                return false;
            }
        }
        if (params.min_ram_gb !== undefined && params.min_ram_gb !== null) {
            if (!product.ram_gb || product.ram_gb < params.min_ram_gb) {
                return false;
            }
        }
        if (params.query) {
            const q = params.query.toLowerCase().trim();
            const matchName = product.name.toLowerCase().includes(q);
            const matchDesc = product.description.toLowerCase().includes(q);
            const matchBrand = product.brand.toLowerCase().includes(q);
            const matchCat = product.category.toLowerCase().includes(q);
            if (!matchName && !matchDesc && !matchBrand && !matchCat) {
                return false;
            }
        }
        return true;
    });
    return {
        products: results,
        total_matches: results.length,
        query_params: params,
    };
}
exports.SHOPPING_TOOLS_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'search_products',
            description: 'Search the local product catalog for headphones, laptops, or phones with criteria like brand, max price, min RAM, etc.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Keywords to search for in product title or description.',
                    },
                    category: {
                        type: 'string',
                        enum: ['headphones', 'laptops', 'phones'],
                        description: 'Product category.',
                    },
                    brand: {
                        type: 'string',
                        description: 'Brand name (e.g., Bose, Sony, Apple, Lenovo, Dell, Acer, Google, Samsung).',
                    },
                    max_price: {
                        type: 'number',
                        description: 'Maximum budget or price in USD.',
                    },
                    min_ram_gb: {
                        type: 'number',
                        description: 'Minimum RAM in GB (for laptops and phones).',
                    },
                },
            },
        },
    },
];
