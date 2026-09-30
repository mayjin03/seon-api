import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("CRITICAL: SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 설정되지 않았습니다.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function formatToStandardNdc(rawNdc) {
  if (!rawNdc) return null;
  if (/^\d{4,5}-\d{3,4}-\d{1,2}$/.test(rawNdc)) return rawNdc;
  
  const digitsOnly = rawNdc.replace(/[^0-9]/g, '');
  if (digitsOnly.length === 10) {
    return `${digitsOnly.slice(0, 5)}-${digitsOnly.slice(5, 8)}-${digitsOnly.slice(8, 10)}`;
  } else if (digitsOnly.length === 11) {
    return `${digitsOnly.slice(0, 5)}-${digitsOnly.slice(5, 9)}-${digitsOnly.slice(9, 11)}`;
  } else if (digitsOnly.length === 8) {
    return `${digitsOnly.slice(0, 5)}-${digitsOnly.slice(5, 8)}-00`;
  }
  return rawNdc;
}

function parseActiveIngredientsArray(ingredients) {
  if (!ingredients) return ['UNKNOWN'];
  if (Array.isArray(ingredients)) {
    const list = ingredients.map(ing => {
      if (typeof ing === 'object' && ing !== null) {
        return ing.name || ing.active_ingredient || JSON.stringify(ing);
      }
      return String(ing);
    }).filter(Boolean);
    return list.length > 0 ? list : ['UNKNOWN'];
  }
  if (typeof ingredients === 'string') {
    return [ingredients];
  }
  return ['UNKNOWN'];
}

async function fetchAndIngestVetNdc() {
  console.log("[1/3] openFDA 수의용 의약품 데이터 전체 수집 시작...");
  
  let skip = 0;
  const limit = 1000;
  let hasMore = true;
  let totalIngested = 0;

  while (hasMore) {
    const url = `https://api.fda.gov/other/nsde.json?search=product_type:("PRESCRIPTION ANIMAL DRUG"+OR+"OTC ANIMAL DRUG")&limit=${limit}&skip=${skip}`;
    console.log(`[+] API 요청 중 (skip: ${skip}, limit: ${limit})...`);
    
    try {
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 404 || response.status === 400) {
          console.log("[i] 데이터 수집 범위를 모두 순회했습니다.");
          break;
        }
        throw new Error(`FDA API Error Status: ${response.status}`);
      }
      
      const data = await response.json();
      const results = data.results || [];
      
      if (results.length === 0) {
        hasMore = false;
        break;
      }

      const formattedRecords = results.map(item => {
        const stdNdc = formatToStandardNdc(item.package_ndc || item.package_ndc11);
        const propName = item.proprietary_name || 'UNKNOWN';
        const nonPropName = item.nonproprietary_name || propName || 'UNKNOWN';
        const activeIngredientsArray = parseActiveIngredientsArray(item.active_ingredients);

        return {
          ndc_code: stdNdc,
          proprietary_name: propName,
          nonproprietary_name: nonPropName,
          product_type: 'VETERINARY',
          active_ingredients: activeIngredientsArray
        };
      }).filter(r => r.ndc_code);

      if (formattedRecords.length > 0) {
        const { error } = await supabase
          .from('fda_ndc_vet_dictionary')
          .upsert(formattedRecords, { onConflict: 'ndc_code' });

        if (error) {
          console.error(`[ERROR] Batch 적재 실패 (skip: ${skip}):`, error.message);
        } else {
          totalIngested += formattedRecords.length;
          console.log(`[+] ${formattedRecords.length}건 성공적으로 업서트 완료! (현재 누적: ${totalIngested}건)`);
        }
      }

      if (results.length < limit) {
        hasMore = false;
      } else {
        skip += limit;
      }

    } catch (err) {
      console.error(`[ERROR] 수집 도중 오류 발생:`, err.message);
      hasMore = false;
    }
  }

  console.log(`\n=== 성공: 총 ${totalIngested}건의 정식 수의용 FDA NDC 데이터가 Supabase DB에 적재 완료되었습니다! ===`);
}

fetchAndIngestVetNdc();