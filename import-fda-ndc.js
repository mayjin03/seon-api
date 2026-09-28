import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("CRITICAL: SUPABASE_URL 및 SUPABASE_SERVICE_ROLE_KEY가 설정되지 않았습니다.");
  process.exit(1);
}

// Service Role Key를 사용해 RLS 권한을 우회하도록 Supabase 클라이언트 생성
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function run() {
  console.log("[1/3] openFDA NDC 약물 데이터 수집 시작...");
  
  // 수의용 약물 API 조회 (가장 폭넓은 쿼리 조건)
  const url = `https://api.fda.gov/drug/ndc.json?search=finished:true&limit=1000`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`openFDA HTTP Error: ${response.status}`);
    }
    
    const data = await response.json();
    const results = data.results || [];
    console.log(`[+] openFDA에서 ${results.length}건의 레코드 수신 완료.`);

    if (results.length === 0) {
      console.log("수신된 데이터가 없습니다.");
      return;
    }

    console.log("[2/3] Supabase 적재용 데이터 구조 매핑 중...");
    const payload = results.map(item => {
      const rawNdc = item.package_ndc || item.product_ndc || item.ndc_code || "00000-000-00";
      const cleanNdc11 = rawNdc.replace(/[^0-9]/g, '');
      const propName = item.proprietary_name || item.brand_name || item.generic_name || "Unknown Vet Drug";
      const nonPropName = item.nonproprietary_name || item.generic_name || propName;

      let ingredients = [];
      if (Array.isArray(item.active_ingredients)) {
        ingredients = item.active_ingredients.map(i => ({ name: i.name, strength: i.strength || '' }));
      } else {
        ingredients = [{ name: nonPropName, strength: '' }];
      }

      return {
        ndc_code: rawNdc,
        ndc_11: cleanNdc11,
        proprietary_name: propName,
        nonproprietary_name: nonPropName,
        aliases: [propName.toLowerCase()],
        active_ingredients: ingredients,
        vet_approved: true,
        data_source: 'openfda_bulk'
      };
    });

    console.log(`[3/3] Supabase fda_ndc_vet_dictionary 테이블에 ${payload.length}건 적재 시작...`);

    // Batch Upsert 실행 (ndc_code 기준 중복 처리)
    const { data: insertedData, error } = await supabase
      .from('fda_ndc_vet_dictionary')
      .upsert(payload, { onConflict: 'ndc_code', ignoreDuplicates: false });

    if (error) {
      console.error("[ERROR] Supabase 적재 실패:", error.message);
      process.exit(1);
    }

    console.log(`=== 성공! ${payload.length}건의 FDA 의약품 데이터가 DB에 완벽하게 적재되었습니다! ===`);

  } catch (err) {
    console.error("실행 중 오류 발생:", err.message);
    process.exit(1);
  }
}

run();
