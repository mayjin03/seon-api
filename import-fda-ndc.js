const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("CRITICAL: SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 설정되지 않았습니다.");
  process.exit(1);
}

// fda_ndc_code_format 제약조건을 충족하도록 NDC 코드 포맷팅
function formatToStandardNdc(rawNdc) {
  if (!rawNdc) return null;
  
  // 이미 하이픈 2개가 들어간 정식 10/11자리 포맷 (예: 12345-678-90 또는 1234-5678-90)
  if (/^\d{4,5}-\d{3,4}-\d{1,2}$/.test(rawNdc)) {
    return rawNdc;
  }

  // 하이픈이 1개만 있는 경우 (예: 81471-693 -> 81471-693-00)
  const digitsOnly = rawNdc.replace(/[^0-9]/g, '');
  if (digitsOnly.length === 10) {
    return `${digitsOnly.slice(0, 5)}-${digitsOnly.slice(5, 8)}-${digitsOnly.slice(8, 10)}`;
  } else if (digitsOnly.length === 11) {
    return `${digitsOnly.slice(0, 5)}-${digitsOnly.slice(5, 9)}-${digitsOnly.slice(9, 11)}`;
  } else if (digitsOnly.length === 8) {
    return `${digitsOnly.slice(0, 5)}-${digitsOnly.slice(5, 8)}-00`;
  } else if (digitsOnly.length === 9) {
    return `${digitsOnly.slice(0, 5)}-${digitsOnly.slice(5, 8)}-0${digitsOnly.slice(8, 9)}`;
  }

  return null;
}

async function run() {
  console.log("[1/3] openFDA 수의용 의약품 데이터 수집 중...");
  
  const fdaRes = await fetch('https://api.fda.gov/drug/ndc.json?search=finished:true&limit=1000');
  if (!fdaRes.ok) {
    console.error("openFDA API 호출 실패:", fdaRes.status);
    process.exit(1);
  }
  
  const fdaData = await fdaRes.json();
  const results = fdaData.results || [];
  console.log(`[+] openFDA에서 ${results.length}건 수신 완료.`);

  const map = new Map();
  for (const item of results) {
    const rawNdc = item.package_ndc || item.product_ndc || item.ndc_code;
    const validNdcCode = formatToStandardNdc(rawNdc);
    
    // DB fda_ndc_code_format 제약조건을 완벽히 충족하는 데이터만 추출
    if (!validNdcCode) continue;

    const propName = item.proprietary_name || item.brand_name || item.generic_name || "Veterinary Drug";
    const nonPropName = item.nonproprietary_name || item.generic_name || propName;

    let ingredients = [];
    if (Array.isArray(item.active_ingredients) && item.active_ingredients.length > 0) {
      ingredients = item.active_ingredients.map(i => ({ 
        name: i.name || nonPropName, 
        strength: i.strength || '' 
      }));
    } else {
      ingredients = [{ name: nonPropName, strength: '' }];
    }

    map.set(validNdcCode, {
      ndc_code: validNdcCode,
      proprietary_name: propName,
      nonproprietary_name: nonPropName,
      aliases: [propName.toLowerCase()],
      active_ingredients: ingredients
    });
  }

  const payload = Array.from(map.values());
  console.log(`[2/3] 포맷 검증을 통과한 유효 NDC 데이터 ${payload.length}건 전송 시작...`);

  const baseUrl = SUPABASE_URL.replace(/\/$/, '');
  const endpoint = `${baseUrl}/rest/v1/fda_ndc_vet_dictionary`;
  
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

  console.log(`=== 성공: 총 ${inserted}건의 정식 FDA NDC 데이터가 Supabase DB에 최종 적재되었습니다! ===`);
}

run();
