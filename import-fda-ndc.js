const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("CRITICAL: SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 없습니다.");
  process.exit(1);
}

async function run() {
  console.log("[1/3] openFDA 수의용 약물 수집 중...");
  
  // openFDA API 호출
  const fdaRes = await fetch('https://api.fda.gov/drug/ndc.json?search=finished:true&limit=1000');
  if (!fdaRes.ok) {
    console.error("openFDA API 호출 실패:", fdaRes.status);
    process.exit(1);
  }
  
  const fdaData = await fdaRes.json();
  const results = fdaData.results || [];
  console.log(`[+] openFDA에서 ${results.length}건 수신 완료.`);

  // 데이터 가공 및 중복 제거
  const map = new Map();
  for (const item of results) {
    const rawNdc = item.package_ndc || item.product_ndc || item.ndc_code;
    if (!rawNdc) continue;

    const cleanNdc11 = rawNdc.replace(/[^0-9]/g, '');
    const propName = item.proprietary_name || item.brand_name || item.generic_name || "Veterinary Drug";
    const nonPropName = item.nonproprietary_name || item.generic_name || propName;

    let ingredients = [];
    if (Array.isArray(item.active_ingredients)) {
      ingredients = item.active_ingredients.map(i => ({ name: i.name, strength: i.strength || '' }));
    } else {
      ingredients = [{ name: nonPropName, strength: '' }];
    }

    map.set(cleanNdc11, {
      ndc_code: rawNdc,
      ndc_11: cleanNdc11,
      proprietary_name: propName,
      nonproprietary_name: nonPropName,
      aliases: [propName.toLowerCase()],
      active_ingredients: ingredients,
      vet_approved: true,
      data_source: 'openfda_bulk'
    });
  }

  const payload = Array.from(map.values());
  console.log(`[2/3] 정제된 데이터 ${payload.length}건을 Supabase REST API로 직접 전송합니다...`);

  // Supabase REST API 직접 호출 (POST ignore-duplicates)
  const endpoint = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/fda_ndc_vet_dictionary`;
  
  const batchSize = 100;
  let inserted = 0;

  for (let i = 0; i < payload.length; i += batchSize) {
    const batch = payload.slice(i, i + batchSize);
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=ignore-duplicates'
      },
      body: JSON.stringify(batch)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[ERROR] Batch ${Math.floor(i / batchSize) + 1} 실패 (Status ${response.status}):`, errText);
    } else {
      inserted += batch.length;
    }
  }

  console.log(`=== 완료: 총 ${inserted}건의 데이터가 Supabase DB에 저장되었습니다! ===`);
}

run();
