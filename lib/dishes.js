/* ============================================================
   Tally dishes — typical takeaway & restaurant portions.
   ------------------------------------------------------------
   Restaurant food mostly isn't in Open Food Facts, so a Deliveroo
   order or a restaurant bill would otherwise have nothing to match.
   This is a small, offline table of typical UK portions, compiled
   from chains' published nutrition and UK takeaway surveys.

   These are ESTIMATES. Real portions vary a lot between restaurants
   (a takeaway korma can be anywhere from 700 to 1,200 kcal), and the
   UI always labels them that way. They're there so a meal out is logged
   approximately rather than not at all.

   Each dish: name, keyword phrases (all words of a phrase must appear),
   typical portion grams `g`, and per-portion kcal/protein/carbs/fat.
   `count` marks dishes sold by the piece (nuggets, wings, gyoza): the
   values are for `count` pieces and a number in the line scales them.
   `kind: 'pizza'` scales by diameter (values are for a 12" pizza).
   `mainForMeal` marks items that a "… meal" deal comes with fries + drink.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyDishes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* [name, keywords, g, kcal, protein, carbs, fat, extra] */
  const RAW = [
    // ── burgers, chicken shops ──
    ['Big Mac', ['big mac'], 215, 508, 26, 42, 25, { mainForMeal: true }],
    ['Cheeseburger', ['cheeseburger', 'cheese burger'], 116, 298, 15, 31, 12, { mainForMeal: true }],
    ['Double cheeseburger', ['double cheeseburger', 'double cheese burger'], 165, 445, 26, 33, 23, { mainForMeal: true }],
    ['Quarter Pounder with cheese', ['quarter pounder', 'qpc'], 200, 518, 30, 38, 26, { mainForMeal: true }],
    ['McChicken sandwich', ['mcchicken', 'chicken sandwich'], 170, 388, 17, 40, 17, { mainForMeal: true }],
    ['Filet-O-Fish', ['filet o fish', 'fillet o fish', 'fish burger'], 142, 329, 15, 38, 13, { mainForMeal: true }],
    ['Chicken nuggets (6)', ['nugget', 'mcnugget', 'chicken bites'], 105, 259, 15, 16, 15, { count: 6, mainForMeal: true }],
    ['Fries (medium)', ['fries', 'french fries', 'skinny fries'], 114, 337, 3.4, 42, 17],
    ['Sweet potato fries', ['sweet potato fries'], 150, 400, 4, 52, 19],
    ['Loaded fries', ['loaded fries', 'dirty fries', 'cheesy fries'], 300, 780, 20, 70, 46],
    ['Beef burger (restaurant)', ['burger', 'beef burger', 'smash burger', 'smashburger'], 250, 650, 35, 40, 37, { mainForMeal: true }],
    ['Chicken burger', ['chicken burger', 'zinger', 'chicken fillet burger'], 230, 550, 30, 45, 26, { mainForMeal: true }],
    ['Veggie burger', ['veggie burger', 'vegan burger', 'bean burger', 'plant burger'], 240, 520, 18, 55, 24, { mainForMeal: true }],
    ['Fried chicken (per piece)', ['fried chicken', 'chicken piece', 'chicken on the bone', 'original recipe'], 120, 290, 20, 10, 18, { count: 1, mainForMeal: true }],
    ['Chicken wings (6)', ['wing', 'hot wings', 'buffalo wings'], 180, 480, 38, 4, 34, { count: 6 }],
    ['Chicken strips (3)', ['strips', 'tenders', 'goujons', 'mini fillets'], 150, 390, 30, 22, 20, { count: 3, mainForMeal: true }],
    ['Popcorn chicken', ['popcorn chicken'], 100, 280, 18, 18, 15],
    ['Onion rings', ['onion rings'], 100, 330, 4, 38, 18],
    ['Hot dog', ['hot dog', 'hotdog'], 150, 380, 13, 30, 23],
    ['Coleslaw', ['coleslaw', 'slaw'], 100, 150, 1, 6, 13],
    ['Corn on the cob', ['corn on the cob', 'corn cob'], 150, 160, 5, 30, 3],
    ['Peri-peri chicken (half)', ['half chicken', 'peri peri chicken', 'nandos'], 330, 600, 75, 2, 33],
    ['Chicken wrap', ['wrap', 'chicken wrap', 'twister'], 220, 520, 28, 50, 22],
    ['Spicy rice', ['spicy rice', 'peri rice'], 200, 300, 6, 55, 6],
    ['Halloumi fries', ['halloumi fries', 'halloumi sticks'], 150, 480, 24, 22, 33],

    // ── pizza (12") ──
    ['Margherita pizza (12")', ['margherita', 'cheese pizza', 'plain pizza'], 560, 1400, 62, 180, 48, { kind: 'pizza' }],
    ['Pepperoni pizza (12")', ['pepperoni', 'american hot', 'diavola'], 600, 1700, 75, 180, 75, { kind: 'pizza' }],
    ['Hawaiian pizza (12")', ['hawaiian', 'ham and pineapple'], 600, 1450, 70, 190, 45, { kind: 'pizza' }],
    ['Meat feast pizza (12")', ['meat feast', 'meateor', 'meat lovers', 'mighty meaty'], 650, 1900, 90, 180, 90, { kind: 'pizza' }],
    ['BBQ chicken pizza (12")', ['bbq chicken pizza', 'texas bbq'], 620, 1600, 85, 200, 50, { kind: 'pizza' }],
    ['Vegetable pizza (12")', ['veggie pizza', 'vegetarian pizza', 'vegi supreme', 'veg pizza', 'garden party'], 600, 1350, 55, 190, 42, { kind: 'pizza' }],
    ['Pizza (12")', ['pizza'], 600, 1550, 68, 185, 58, { kind: 'pizza' }],
    ['Garlic bread', ['garlic bread', 'dough balls', 'garlic pizza bread'], 120, 420, 10, 50, 20],
    ['Chicken kickers / bites', ['kickers', 'chicken bites'], 120, 300, 22, 18, 15],
    ['Cookie', ['cookie', 'cookies'], 60, 290, 3, 38, 14, { count: 1 }],

    // ── Indian ──
    ['Chicken tikka masala', ['chicken tikka masala', 'tikka masala', 'ctm'], 400, 760, 55, 18, 52],
    ['Butter chicken', ['butter chicken', 'murgh makhani', 'makhani'], 400, 780, 50, 22, 54],
    ['Korma', ['korma'], 400, 880, 50, 25, 64],
    ['Jalfrezi', ['jalfrezi'], 400, 520, 50, 18, 28],
    ['Madras', ['madras'], 400, 600, 50, 15, 38],
    ['Vindaloo', ['vindaloo'], 400, 610, 50, 18, 38],
    ['Bhuna', ['bhuna'], 400, 580, 50, 16, 35],
    ['Rogan josh', ['rogan josh'], 400, 560, 48, 16, 33],
    ['Balti', ['balti'], 400, 560, 48, 18, 32],
    ['Dhansak', ['dhansak'], 400, 560, 45, 40, 22],
    ['Pasanda', ['pasanda'], 400, 820, 50, 22, 58],
    ['Saag / palak paneer', ['saag paneer', 'palak paneer'], 300, 480, 22, 15, 38],
    ['Paneer tikka masala', ['paneer'], 350, 650, 25, 25, 50],
    ['Chana masala', ['chana', 'chickpea curry'], 350, 420, 15, 50, 17],
    ['Dal / tarka dal', ['dal', 'daal', 'dhal', 'tarka'], 300, 400, 18, 45, 16],
    ['Curry (generic)', ['curry'], 400, 650, 45, 25, 40],
    ['Biryani', ['biryani', 'biriyani'], 500, 950, 45, 120, 30],
    ['Pilau rice', ['pilau', 'pilaf', 'pulao'], 250, 430, 8, 80, 9],
    ['Boiled rice', ['boiled rice', 'steamed rice', 'plain rice', 'jasmine rice', 'white rice'], 250, 330, 7, 72, 1],
    ['Naan', ['naan', 'nan bread'], 160, 440, 13, 70, 11],
    ['Garlic naan', ['garlic naan', 'garlic nan'], 170, 480, 13, 72, 15],
    ['Peshwari naan', ['peshwari', 'peshawari'], 180, 590, 12, 90, 20],
    ['Keema naan', ['keema naan', 'keema nan'], 200, 600, 22, 75, 22],
    ['Chapati / roti', ['chapati', 'chapatti', 'roti'], 45, 120, 3.7, 20, 3, { count: 1 }],
    ['Paratha', ['paratha'], 90, 320, 6, 40, 15, { count: 1 }],
    ['Poppadom', ['poppadom', 'popadom', 'papadum', 'poppadum'], 13, 65, 3, 6, 4, { count: 1 }],
    ['Onion bhaji', ['bhaji', 'bhajee'], 60, 190, 3, 14, 14, { count: 1 }],
    ['Samosa', ['samosa'], 70, 220, 5, 20, 13, { count: 1 }],
    ['Chicken tikka (starter)', ['chicken tikka'], 200, 320, 50, 5, 11],
    ['Tandoori chicken (half)', ['tandoori'], 300, 450, 65, 6, 19],
    ['Seekh kebab', ['seekh', 'sheek kebab'], 120, 300, 20, 4, 23, { count: 2 }],
    ['Bombay potatoes', ['bombay potato', 'bombay aloo', 'aloo'], 300, 360, 6, 42, 19],
    ['Mango lassi', ['lassi'], 300, 260, 8, 45, 6],

    // ── Chinese ──
    ['Sweet & sour chicken (battered)', ['sweet and sour', 'sweet sour'], 400, 900, 40, 110, 33],
    ['Chicken chow mein', ['chow mein'], 450, 700, 40, 75, 26],
    ['Singapore noodles', ['singapore'], 450, 760, 35, 90, 28],
    ['Special fried rice', ['special fried rice'], 450, 900, 38, 120, 30],
    ['Egg fried rice', ['egg fried rice', 'fried rice'], 300, 540, 13, 88, 15],
    ['Beef in black bean sauce', ['black bean'], 400, 550, 40, 30, 30],
    ['Crispy chilli beef', ['crispy chilli beef', 'crispy beef', 'chilli beef'], 300, 860, 30, 85, 45],
    ['Kung po chicken', ['kung po', 'kung pao'], 400, 600, 45, 30, 34],
    ['Salt & pepper chicken', ['salt and pepper', 'salt pepper', 'salt chilli'], 300, 750, 40, 60, 38],
    ['Crispy aromatic duck (quarter)', ['aromatic duck', 'crispy duck'], 300, 950, 50, 50, 60],
    ['Spare ribs', ['ribs', 'spare ribs'], 300, 700, 45, 20, 50],
    ['Spring roll', ['spring roll'], 60, 150, 3, 18, 7, { count: 1 }],
    ['Prawn crackers', ['prawn cracker'], 60, 320, 1, 33, 20],
    ['Chinese curry sauce', ['curry sauce'], 150, 150, 2, 15, 9],
    ['Sauce / dip pot', ['sauce', 'dip', 'mayo', 'ketchup', 'sweet chilli', 'bbq sauce', 'garlic mayo'], 30, 100, 0.5, 8, 7],
    ['Takeaway chips', ['chips', 'chip'], 250, 560, 7, 75, 25],
    ['Dim sum', ['dim sum', 'har gow', 'siu mai', 'dumpling'], 120, 240, 12, 28, 9, { count: 4 }],

    // ── Thai, Japanese, Korean, Vietnamese ──
    ['Pad thai', ['pad thai'], 400, 800, 35, 95, 30],
    ['Thai green curry', ['green curry'], 400, 650, 35, 15, 50],
    ['Thai red curry', ['red curry', 'panang', 'penang'], 400, 620, 35, 15, 47],
    ['Massaman curry', ['massaman'], 400, 780, 35, 40, 52],
    ['Chicken katsu curry (with rice)', ['chicken katsu curry', 'katsu curry', 'katsu'], 550, 1100, 45, 150, 36],
    ['Ramen', ['ramen'], 650, 700, 35, 80, 25],
    ['Pho', ['pho'], 650, 450, 30, 60, 8],
    ['Teriyaki with rice', ['teriyaki'], 450, 700, 40, 95, 16],
    ['Yaki soba / udon', ['yaki soba', 'yakisoba', 'udon'], 450, 650, 28, 90, 18],
    ['Sushi (per piece)', ['sushi', 'nigiri', 'maki'], 30, 45, 2, 8, 0.5, { count: 1 }],
    ['Sushi roll (8 pieces)', ['california roll', 'roll'], 230, 360, 12, 55, 10],
    ['Gyoza (5)', ['gyoza', 'potsticker'], 125, 300, 12, 32, 13, { count: 5 }],
    ['Bao bun', ['bao'], 110, 280, 11, 34, 11, { count: 1 }],
    ['Korean fried chicken', ['korean fried chicken', 'kfc wings'], 300, 820, 45, 45, 50],
    ['Bibimbap', ['bibimbap'], 500, 650, 28, 90, 20],
    ['Poke bowl', ['poke'], 450, 650, 35, 75, 22],
    ['Edamame', ['edamame'], 150, 180, 16, 13, 8],

    // ── Mexican, kebab, Middle Eastern ──
    ['Burrito', ['burrito'], 450, 980, 45, 110, 38],
    ['Burrito bowl', ['burrito bowl', 'naked burrito', 'bowl'], 500, 750, 40, 80, 28],
    ['Tacos', ['taco'], 120, 230, 12, 18, 12, { count: 1 }],
    ['Nachos', ['nachos'], 350, 900, 25, 80, 52],
    ['Quesadilla', ['quesadilla'], 300, 750, 35, 55, 42],
    ['Doner kebab (large)', ['doner', 'donner', 'gyro'], 450, 1000, 50, 75, 55],
    ['Chicken shish kebab', ['shish', 'shish kebab', 'kebab'], 400, 650, 55, 60, 18],
    ['Shawarma wrap', ['shawarma'], 350, 700, 38, 60, 32],
    ['Falafel wrap', ['falafel'], 350, 700, 20, 85, 30],
    ['Houmous & pitta', ['houmous', 'hummus', 'humous'], 200, 520, 16, 50, 28],

    // ── fish & chips, British, cafés ──
    ['Fish & chips', ['fish and chips', 'fish chips', 'cod and chips', 'haddock and chips', 'fish supper'], 600, 1300, 55, 120, 68],
    ['Battered fish', ['battered cod', 'battered haddock', 'cod', 'haddock', 'fish'], 250, 550, 40, 25, 32],
    ['Battered sausage', ['battered sausage'], 150, 420, 12, 25, 30],
    ['Mushy peas', ['mushy peas', 'peas'], 150, 130, 9, 20, 1],
    ['Gravy', ['gravy'], 100, 40, 1, 6, 1],
    ['Pie (meat, individual)', ['pie'], 250, 650, 22, 55, 38],
    ['Sausage roll', ['sausage roll'], 120, 380, 10, 28, 25, { count: 1 }],
    ['Full English breakfast', ['full english', 'big breakfast', 'fry up'], 450, 850, 45, 50, 50],
    ['Eggs Benedict', ['benedict', 'eggs royale', 'florentine'], 350, 700, 30, 40, 45],
    ['Pancakes with syrup', ['pancake'], 300, 650, 14, 100, 20],
    ['Avocado toast', ['avocado toast', 'avo toast', 'smashed avocado'], 250, 450, 14, 40, 26],
    ['Sandwich', ['sandwich', 'sarnie', 'baguette', 'club'], 220, 480, 25, 45, 20],
    ['Toastie / panini', ['toastie', 'panini', 'croque'], 230, 550, 26, 48, 27],
    ['Jacket potato with cheese', ['jacket potato', 'baked potato'], 400, 550, 20, 70, 20],
    ['Salad (chicken Caesar)', ['caesar', 'salad'], 350, 520, 35, 20, 34],
    ['Soup with bread', ['soup'], 450, 320, 12, 45, 9],
    ['Steak & chips (8oz)', ['steak'], 450, 950, 60, 60, 50],
    ['Sunday roast', ['roast', 'sunday roast', 'carvery'], 600, 900, 50, 80, 40],
    ['Scampi & chips', ['scampi'], 450, 900, 30, 95, 45],
    ['Mac & cheese', ['mac and cheese', 'macaroni cheese', 'mac n cheese'], 350, 650, 25, 60, 34],

    // ── Italian ──
    ['Spaghetti bolognese', ['bolognese', 'spag bol', 'ragu'], 450, 650, 35, 75, 22],
    ['Carbonara', ['carbonara'], 400, 850, 35, 80, 42],
    ['Lasagne', ['lasagne', 'lasagna'], 400, 600, 35, 40, 32],
    ['Penne arrabbiata', ['arrabbiata', 'arrabiata'], 400, 520, 15, 85, 13],
    ['Pasta (generic)', ['pasta', 'penne', 'spaghetti', 'linguine', 'rigatoni', 'tagliatelle', 'gnocchi'], 400, 650, 25, 85, 22],
    ['Risotto', ['risotto'], 400, 650, 18, 80, 26],
    ['Calzone', ['calzone'], 450, 1100, 50, 120, 45],

    // ── desserts ──
    ['Cheesecake (slice)', ['cheesecake'], 120, 420, 6, 38, 27],
    ['Brownie', ['brownie'], 100, 440, 5, 55, 22],
    ['Sticky toffee pudding', ['sticky toffee'], 200, 650, 6, 95, 28],
    ['Chocolate fudge cake', ['fudge cake', 'chocolate cake'], 150, 550, 7, 65, 29],
    ['Tiramisu', ['tiramisu'], 150, 420, 7, 38, 26],
    ['Ice cream (2 scoops)', ['ice cream', 'gelato', 'sundae'], 120, 250, 4, 28, 13],
    ['McFlurry', ['mcflurry', 'flurry'], 190, 340, 8, 50, 11],
    ['Churros', ['churros'], 120, 420, 5, 50, 22],
    ['Doughnut', ['doughnut', 'donut'], 75, 280, 4, 33, 15, { count: 1 }],
    ['Muffin', ['muffin'], 120, 450, 6, 55, 22, { count: 1 }],
    ['Croissant', ['croissant', 'pain au chocolat'], 70, 290, 6, 30, 16, { count: 1 }],

    // ── drinks ──
    ['Diet / zero cola', ['diet coke', 'coke zero', 'pepsi max', 'diet pepsi', 'zero sugar', 'diet', 'zero'], 330, 1, 0, 0, 0],
    ['Cola (330ml)', ['coke', 'coca cola', 'cola', 'pepsi', 'fanta', 'sprite', 'irn bru', 'soft drink', 'fizzy'], 330, 139, 0, 35, 0],
    ['Water', ['water', 'still water', 'sparkling water'], 500, 0, 0, 0, 0],
    ['Orange juice', ['orange juice', 'juice'], 250, 110, 2, 25, 0],
    ['Milkshake', ['milkshake', 'shake', 'thickshake'], 400, 420, 11, 66, 12],
    ['Lager (pint)', ['lager', 'pint', 'beer', 'ipa', 'pale ale', 'peroni', 'cobra', 'kingfisher', 'tiger', 'asahi', 'heineken', 'stella', 'birra moretti', 'moretti', 'corona'], 568, 240, 2, 18, 0],
    ['Cider (pint)', ['cider'], 568, 250, 0, 25, 0],
    ['Wine (175ml)', ['wine', 'merlot', 'malbec', 'rioja', 'sauvignon', 'pinot', 'chardonnay', 'rose', 'shiraz'], 175, 160, 0, 4, 0],
    ['Prosecco (125ml)', ['prosecco', 'champagne', 'cava', 'fizz'], 125, 90, 0, 2, 0],
    ['Cocktail', ['cocktail', 'mojito', 'margarita', 'pornstar', 'daiquiri', 'espresso martini', 'spritz', 'pina colada'], 200, 250, 0, 25, 0],
    ['Spirit & mixer', ['gin and tonic', 'g and t', 'vodka', 'rum and coke', 'whisky', 'gin'], 250, 140, 0, 15, 0],
    ['Latte', ['latte'], 350, 190, 11, 18, 7],
    ['Cappuccino / flat white', ['cappuccino', 'flat white', 'cortado'], 250, 120, 7, 10, 6],
    ['Hot chocolate', ['hot chocolate', 'mocha'], 350, 300, 11, 38, 11],
    ['Frappuccino / iced coffee', ['frappuccino', 'frappe', 'iced latte', 'iced coffee'], 400, 300, 6, 50, 9],
    ['Bubble tea', ['bubble tea', 'boba'], 500, 350, 3, 65, 8],
    ['Smoothie', ['smoothie'], 400, 250, 4, 55, 1],
    ['Tea / black coffee', ['tea', 'americano', 'espresso', 'black coffee', 'filter coffee'], 250, 5, 0, 1, 0],
  ];

  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const DISHES = RAW.map(([name, kw, g, kcal, protein, carbs, fat, extra]) => ({
    id: 'dish:' + slug(name), name, kw: kw.map((p) => p.split(' ')), g, kcal, protein, carbs, fat, ...(extra || {}),
  }));

  /* '1/2 Chicken' and '½ chicken' are how menus write a half chicken. */
  const normalise = (s) => String(s || '').toLowerCase().replace(/(^|\s)(?:1\/2|½)(?=\s|$)/g, ' half ')
    .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9"]+/g, ' ').trim();

  /* Each keyword word must start a word in the name ("wing" ↔ "wings").
     Short keywords must match exactly, or "pie" would hit "pieces" and
     "tea" would hit "teriyaki". */
  function phraseHits(words, phrase) {
    return phrase.every((p) => words.some((w) => w === p || (p.length >= 4 && w.startsWith(p))));
  }

  /* One-word catch-alls lose to anything more specific: "chicken katsu
     curry" is katsu, not "a curry"; "pepperoni pizza" isn't just "pizza". */
  const GENERIC = new Set(['curry', 'pizza', 'pasta', 'burger', 'fish', 'chips', 'chip', 'fries', 'roll', 'bowl', 'wrap',
    'salad', 'kebab', 'pie', 'roast', 'sandwich', 'soup', 'steak', 'wine', 'beer', 'pint', 'juice', 'tea', 'water', 'diet',
    'zero', 'shake', 'sauce', 'dip', 'cookie', 'cookies', 'club', 'peas', 'gin', 'vodka', 'fizz', 'strips']);

  /* Best-matching dish: the one whose matched phrase has the most words, so
     "diet coke" beats "coke" and "garlic naan" beats "naan". With
     `mains`, only dishes a meal deal is built around are considered — so
     "Big Mac Meal, Diet Coke" is the meal, not the drink. */
  function findDish(name, { mains = false } = {}) {
    const words = normalise(name).split(' ').filter(Boolean);
    let best = null;
    for (const d of DISHES) {
      if (mains && !d.mainForMeal) continue;
      for (const ph of d.kw) {
        if (!phraseHits(words, ph)) continue;
        const score = ph.length * 10 + ph.join('').length / 10 - (ph.length === 1 && GENERIC.has(ph[0]) ? 5 : 0);
        if (!best || score > best.score) best = { dish: d, score };
      }
    }
    return best ? best.dish : null;
  }

  /* Size words, pizza diameter and piece counts → a portion multiplier. */
  function portionFactor(name, dish) {
    const s = normalise(name);
    let f = 1;
    if (/\b(small|kids?|mini|regular small|snack)\b/.test(s)) f = 0.7;
    if (/\b(large|lrg|lge|big)\b/.test(s) && !/\bbig mac\b/.test(s)) f = 1.3;
    if (/\b(xl|extra large|mega|giant)\b/.test(s)) f = 1.6;
    if (/\bhalf\b/.test(s) && !/half chicken/.test(s)) f *= 0.5;
    if (/\b(sharing|for 2|for two|family)\b/.test(s)) f *= 2;
    if (dish.kind === 'pizza') {
      const m = /(\d{1,2}(?:\.\d)?)\s*(?:"|in\b|inch)/.exec(s);
      if (m) f = Math.pow(Number(m[1]) / 12, 2);
      else if (/\b(personal|small)\b/.test(s)) f = 0.55;
      else if (/\bmedium\b/.test(s)) f = 0.85;
      else if (/\b(large)\b/.test(s)) f = 1.25;
    }
    if (dish.count) {
      /* "9 Chicken McNuggets", "20pc wings", "box of 12" */
      const m = /\b(\d{1,3})\s*(?:pc|pcs|piece|pieces|x)?\b(?!\s*(?:g|ml|kg|l|cl|"|in|inch))/.exec(s);
      if (m && Number(m[1]) > 0 && Number(m[1]) <= 100) f = Number(m[1]) / dish.count;
    }
    return Math.max(0.2, Math.min(f, 12));
  }

  const FRIES = DISHES.find((d) => d.id === 'dish:fries-medium');
  const COLA = DISHES.find((d) => d.id === 'dish:cola-330ml');
  const DIET = DISHES.find((d) => d.id === 'dish:diet-zero-cola');

  /* A dish as a Tally food: per-100g values plus a one-portion serving, so
     the portion picker, aliases and the log treat it like any other food. */
  function asFood(d, label) {
    const per = (v) => Math.round((v / d.g) * 1000) / 10;
    return {
      id: d.id, name: label || d.name, brand: 'Typical portion', estimate: true, unit: 'g',
      per100: { kcal: Math.round((d.kcal / d.g) * 100), protein: per(d.protein), carbs: per(d.carbs), fat: per(d.fat) },
      serving: { g: d.g, label: '1 portion' }, source: 'estimate',
    };
  }

  /* Receipt line / search text → { food, grams } estimate, or null.
     "Big Mac Meal" becomes burger + medium fries + regular drink (diet if
     the line says so), as one food. */
  function estimate(name) {
    const isMeal = /\bmeal\b/.test(normalise(name));
    const d = (isMeal && findDish(name, { mains: true })) || findDish(name);
    if (!d) return null;
    const f = portionFactor(name, d);
    const s = normalise(name);
    if (d.mainForMeal && /\bmeal\b/.test(s)) {
      const drink = /\b(diet|zero|max|water)\b/.test(s) ? DIET : COLA;
      const sizeUp = /\blarge\b/.test(s) ? 1.3 : 1;
      const parts = [[d, d.count ? f : 1], [FRIES, sizeUp], [drink, sizeUp]];
      const sum = (k) => parts.reduce((a, [p, m]) => a + p[k] * m, 0);
      const combo = { id: d.id + '-meal' + (sizeUp > 1 ? '-large' : ''), g: sum('g'), kcal: sum('kcal'), protein: sum('protein'), carbs: sum('carbs'), fat: sum('fat') };
      const food = asFood(combo, `${d.name.replace(/ \(.*\)$/, '')} meal (with fries & ${drink === DIET ? 'diet drink' : 'regular drink'})`);
      return { food, grams: combo.g, dish: d };
    }
    return { food: asFood(d), grams: Math.round(d.g * f), dish: d };
  }

  /* For the search sheet: dishes whose name or keywords match the query. */
  function search(q, limit = 6) {
    const words = normalise(q).split(' ').filter((w) => w.length >= 2);
    if (!words.length) return [];
    const hits = [];
    for (const d of DISHES) {
      const hay = normalise(d.name + ' ' + d.kw.map((p) => p.join(' ')).join(' '));
      if (words.every((w) => hay.split(' ').some((h) => h.startsWith(w)))) hits.push(asFood(d));
    }
    return hits.slice(0, limit);
  }

  return { DISHES, findDish, portionFactor, estimate, search, asFood };
});
