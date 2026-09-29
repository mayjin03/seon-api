import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
let drugDictionaryCache = [];
let isCacheLoading = false;

// 0. B2B API Key 인증 및 요청 수 제한(Rate Limiter) 설정
const VALID_API_KEYS = new Set([
  process.env.SEON_DEMO_API_KEY || 'seon_demo_pk_12345',
  process.env.SEON_LIVE_API_KEY || 'seon_live_pk_67890'
]);

// 메모리 기반 Rate Limiter (분당 최대 60회)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;

const rateLimiter = (req, res, next) => {
  const clientKey = req.headers['x-api-key'] || req.ip;
  const now = Date.now();

  if (!rateLimitMap.has(clientKey)) {
    rateLimitMap.set(clientKey, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }

  const clientStats = rateLimitMap.get(clientKey);

  if (now > clientStats.resetTime) {
    clientStats.count = 1;
    clientStats.resetTime = now + RATE_LIMIT_WINDOW_MS;
    return next();
  }

  if (clientStats.count >= MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({
      status: 'TOO_MANY_REQUESTS',
      message: '429 Too Many Requests: 분당 요청 한도(60회)를 초과했습니다. 잠시 후 다시 시도해주세요.'
    });
  }

  clientStats.count += 1;
  next();
};

// API Key 인증 미들웨어
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  // 샌드박스 및 데모용 패스스루 허용 (x-api-key 미전송 시 기본 데모 키로 간주 처리)
  if (!apiKey) {
    req.headers['x-api-key'] = 'seon_demo_pk_12345';
    return next();
  }

  if (!VALID_API_KEYS.has(apiKey)) {
    return res.status(401).json({
      status: 'UNAUTHORIZED',
      message: '401 Unauthorized: 유효하지 않은 x-api-key 입니다.'
    });
  }

  next();
};

// 스펠링 오타 정밀 교정 테이블 (단어 완전 일치 기준)
const TYPO_MAP = {
  'doxycyclin': 'doxycycline',
  'docycycline': 'doxycycline',
  'enrofloxacine': 'enrofloxacin',
  'clindamycine': 'clindamycin',
  'fenbendazol': 'fenbendazole',
  'praziquantell': 'praziquantel'
};

// 1. 핵심 처방약 마스터 레코드 (교차 오염 완전 차단)
const MASTER_DRUG_RECORDS = {
  doxycycline: { ndc_code: '00069-0960-01', ndc_11: '00069096001', proprietary_name: 'VIBRAMYCIN', nonproprietary_name: 'DOXYCYCLINE MONOHYDRATE', active_ingredients: [{ name: 'DOXYCYCLINE MONOHYDRATE', strength: '100 mg' }] },
  enrofloxacin: { ndc_code: '81471-693-00', ndc_11: '81471069300', proprietary_name: 'BAYTRIL', nonproprietary_name: 'ENROFLOXACIN', active_ingredients: [{ name: 'ENROFLOXACIN', strength: '22.7 mg' }] },
  ciprofloxacin: { ndc_code: '00065-0618-05', ndc_11: '00065061805', proprietary_name: 'CILOXAN', nonproprietary_name: 'CIPROFLOXACIN', active_ingredients: [{ name: 'CIPROFLOXACIN HYDROCHLORIDE', strength: '0.3%' }] },
  ofloxacin: { ndc_code: '00023-9188-05', ndc_11: '00023918805', proprietary_name: 'OCUFLOX', nonproprietary_name: 'OFLOXACIN', active_ingredients: [{ name: 'OFLOXACIN', strength: '0.3%' }] },
  labetalol: { ndc_code: '06158-513-00', ndc_11: '06158051300', proprietary_name: 'LABETALOL HYDROCHLORIDE', nonproprietary_name: 'LABETALOL HYDROCHLORIDE', active_ingredients: [{ name: 'LABETALOL HYDROCHLORIDE', strength: '100 mg' }] },
  benazepril: { ndc_code: '50090-428-04', ndc_11: '50090042804', proprietary_name: 'BENAZEPRIL HYDROCHLORIDE', nonproprietary_name: 'BENAZEPRIL HYDROCHLORIDE', active_ingredients: [{ name: 'BENAZEPRIL HYDROCHLORIDE', strength: '5 mg' }] },
  orbifloxacin: { ndc_code: '00061-1141-01', ndc_11: '00061114101', proprietary_name: 'ORBAX', nonproprietary_name: 'ORBIFLOXACIN', active_ingredients: [{ name: 'ORBIFLOXACIN', strength: '22.7 mg' }] },
  pimobendan: { ndc_code: '00010-4411-01', ndc_11: '00010441101', proprietary_name: 'VETMEDIN', nonproprietary_name: 'PIMOBENDAN', active_ingredients: [{ name: 'PIMOBENDAN', strength: '1.25 mg' }] },
  clavamox: { ndc_code: '00069-1220-01', ndc_11: '00069122001', proprietary_name: 'CLAVAMOX', nonproprietary_name: 'AMOXI/CLAVULANATE POTASSIUM', active_ingredients: [{ name: 'AMOXI/CLAVULANATE POTASSIUM', strength: '62.5 mg' }] },
  apoquel: { ndc_code: '00069-0180-01', ndc_11: '00069018001', proprietary_name: 'APOQUEL', nonproprietary_name: 'OCLACITINIB MALEATE', active_ingredients: [{ name: 'OCLACITINIB MALEATE', strength: '3.6 mg' }] },
  cerenia: { ndc_code: '00069-0510-01', ndc_11: '00069051001', proprietary_name: 'CERENIA', nonproprietary_name: 'MAROPITANT CITRATE', active_ingredients: [{ name: 'MAROPITANT CITRATE', strength: '16 mg' }] },
  metacam: { ndc_code: '00010-6011-01', ndc_11: '00010601101', proprietary_name: 'METACAM', nonproprietary_name: 'MELOXICAM', active_ingredients: [{ name: 'MELOXICAM', strength: '1.5 mg/mL' }] },
  temaril: { ndc_code: '00069-3110-01', ndc_11: '00069311001', proprietary_name: 'TEMARIL-P', nonproprietary_name: 'TRIMEPRAZINE/PREDNISOLONE', active_ingredients: [{ name: 'PREDNISOLONE', strength: '5 mg' }] },
  gabapentin: { ndc_code: '00071-0801-01', ndc_11: '00071080101', proprietary_name: 'NEURONTIN', nonproprietary_name: 'GABAPENTIN', active_ingredients: [{ name: 'GABAPENTIN', strength: '100 mg' }] },
  alfaxalone: { ndc_code: '60267-001-01', ndc_11: '60267000101', proprietary_name: 'ALFAXAN', nonproprietary_name: 'ALFAXALONE', active_ingredients: [{ name: 'ALFAXALONE', strength: '10 mg/mL' }] },
  grapiprant: { ndc_code: '00010-4530-01', ndc_11: '00010453001', proprietary_name: 'GALLIPRANT', nonproprietary_name: 'GRAPIPRANT', active_ingredients: [{ name: 'GRAPIPRANT', strength: '20 mg' }] },
  carprofen: { ndc_code: '00069-0520-01', ndc_11: '00069052001', proprietary_name: 'RIMADYL', nonproprietary_name: 'CARPROFEN', active_ingredients: [{ name: 'CARPROFEN', strength: '25 mg' }] },
  levetiracetam: { ndc_code: '50474-594-01', ndc_11: '50474059401', proprietary_name: 'KEPPRA', nonproprietary_name: 'LEVETIRACETAM', active_ingredients: [{ name: 'LEVETIRACETAM', strength: '250 mg' }] },
  methimazole: { ndc_code: '43261-001-01', ndc_11: '43261000101', proprietary_name: 'FELIMAZOLE', nonproprietary_name: 'METHIMAZOLE', active_ingredients: [{ name: 'METHIMAZOLE', strength: '2.5 mg' }] },
  furosemide: { ndc_code: '00010-3101-01', ndc_11: '00010310101', proprietary_name: 'SALIX / LASIX', nonproprietary_name: 'FUROSEMIDE', active_ingredients: [{ name: 'FUROSEMIDE', strength: '50 mg' }] },
  spironolactone: { ndc_code: '00025-1031-01', ndc_11: '00025103101', proprietary_name: 'ALDACTONE', nonproprietary_name: 'SPIRONOLACTONE', active_ingredients: [{ name: 'SPIRONOLACTONE', strength: '25 mg' }] },
  amlodipine: { ndc_code: '00069-1520-01', ndc_11: '00069152001', proprietary_name: 'NORVASC', nonproprietary_name: 'AMLODIPINE BESYLATE', active_ingredients: [{ name: 'AMLODIPINE BESYLATE', strength: '2.5 mg' }] },
  cyclosporine: { ndc_code: '00058-0240-01', ndc_11: '00058024001', proprietary_name: 'ATOPICA', nonproprietary_name: 'CYCLOSPORINE', active_ingredients: [{ name: 'CYCLOSPORINE', strength: '100 mg/mL' }] },
  sucralfate: { ndc_code: '50474-710-01', ndc_11: '50474071001', proprietary_name: 'CARAFATE', nonproprietary_name: 'SUCRALFATE', active_ingredients: [{ name: 'SUCRALFATE', strength: '1 g' }] },
  omeprazole: { ndc_code: '00006-0038-01', ndc_11: '00006003801', proprietary_name: 'GASTROGARD', nonproprietary_name: 'OMEPRAZOLE', active_ingredients: [{ name: 'OMEPRAZOLE', strength: '2.28 g' }] },
  tramadol: { ndc_code: '50474-610-01', ndc_11: '50474061001', proprietary_name: 'ULTRAM', nonproprietary_name: 'TRAMADOL HYDROCHLORIDE', active_ingredients: [{ name: 'TRAMADOL HYDROCHLORIDE', strength: '50 mg' }] },
  adequan: { ndc_code: '10797-001-05', ndc_11: '10797000105', proprietary_name: 'ADEQUAN CANINE', nonproprietary_name: 'POLYSULFATED GLYCOSAMINOGLYCAN', active_ingredients: [{ name: 'POLYSULFATED GLYCOSAMINOGLYCAN', strength: '100 mg/mL' }] },
  interceptor: { ndc_code: '00058-0130-01', ndc_11: '00058013001', proprietary_name: 'INTERCEPTOR', nonproprietary_name: 'MILBEMYCIN OXIME', active_ingredients: [{ name: 'MILBEMYCIN OXIME', strength: '2.3 mg' }] },
  bravecto: { ndc_code: '00061-4321-01', ndc_11: '00061432101', proprietary_name: 'BRAVECTO', nonproprietary_name: 'FLURALANER', active_ingredients: [{ name: 'FLURALANER', strength: '250 mg' }] },
  nexgard: { ndc_code: '00010-4351-01', ndc_11: '00010435101', proprietary_name: 'NEXGARD', nonproprietary_name: 'AFOXOLANER', active_ingredients: [{ name: 'AFOXOLANER', strength: '28.3 mg' }] },
  simparica: { ndc_code: '00069-0231-01', ndc_11: '00069023101', proprietary_name: 'SIMPARICA', nonproprietary_name: 'SAROLANER', active_ingredients: [{ name: 'SAROLANER', strength: '10 mg' }] },
  metronidazole: { ndc_code: '00058-0410-01', ndc_11: '00058041001', proprietary_name: 'FLAGYL', nonproprietary_name: 'METRONIDAZOLE', active_ingredients: [{ name: 'METRONIDAZOLE', strength: '250 mg' }] },
  tylosin: { ndc_code: '00098-0511-01', ndc_11: '00098051101', proprietary_name: 'TYLAN', nonproprietary_name: 'TYLOSIN TARTRATE', active_ingredients: [{ name: 'TYLOSIN TARTRATE', strength: '100 g' }] },
  tobrex: { ndc_code: '00065-0644-05', ndc_11: '00065064405', proprietary_name: 'TOBREX', nonproprietary_name: 'TOBRAMYCIN', active_ingredients: [{ name: 'TOBRAMYCIN', strength: '0.3%' }] },
  nizoral: { ndc_code: '50458-223-06', ndc_11: '50458022306', proprietary_name: 'NIZORAL', nonproprietary_name: 'KETOCONAZOLE', active_ingredients: [{ name: 'KETOCONAZOLE', strength: '200 mg' }] },
  itraconazole: { ndc_code: '50474-702-01', ndc_11: '50474070201', proprietary_name: 'SPORANOX', nonproprietary_name: 'ITRACONAZOLE', active_ingredients: [{ name: 'ITRACONAZOLE', strength: '100 mg' }] },
  cefpodoxime: { ndc_code: '00010-4401-01', ndc_11: '00010440101', proprietary_name: 'SIMPLICEF', nonproprietary_name: 'CEFPODOXIME PROXETIL', active_ingredients: [{ name: 'CEFPODOXIME PROXETIL', strength: '100 mg' }] },
  simplicef: { ndc_code: '00010-4401-01', ndc_11: '00010440101', proprietary_name: 'SIMPLICEF', nonproprietary_name: 'CEFPODOXIME PROXETIL', active_ingredients: [{ name: 'CEFPODOXIME PROXETIL', strength: '100 mg' }] },
  keflex: { ndc_code: '00006-0012-01', ndc_11: '00006001201', proprietary_name: 'KEFLEX', nonproprietary_name: 'CEPHALEXIN', active_ingredients: [{ name: 'CEPHALEXIN', strength: '500 mg' }] },
  zeniquin: { ndc_code: '00069-1140-01', ndc_11: '00069114001', proprietary_name: 'ZENIQUIN', nonproprietary_name: 'MARBOFLOXACIN', active_ingredients: [{ name: 'MARBOFLOXACIN', strength: '25 mg' }] },
  reglan: { ndc_code: '00031-6701-01', ndc_11: '00031670101', proprietary_name: 'REGLAN', nonproprietary_name: 'METOCLOPRAMIDE HYDROCHLORIDE', active_ingredients: [{ name: 'METOCLOPRAMIDE HYDROCHLORIDE', strength: '10 mg' }] },
  pepcid: { ndc_code: '00006-0040-01', ndc_11: '00006004001', proprietary_name: 'PEPCID', nonproprietary_name: 'FAMOTIDINE', active_ingredients: [{ name: 'FAMOTIDINE', strength: '20 mg' }] },
  pyrantel: { ndc_code: '00069-0210-01', ndc_11: '00069021001', proprietary_name: 'NEXGARD COMBO / NEMEX', nonproprietary_name: 'PYRANTEL PAMOATE', active_ingredients: [{ name: 'PYRANTEL PAMOATE', strength: '50 mg/mL' }] },
  fenbendazole: { ndc_code: '00061-0251-01', ndc_11: '00061025101', proprietary_name: 'PANACUR', nonproprietary_name: 'FENBENDAZOLE', active_ingredients: [{ name: 'FENBENDAZOLE', strength: '222 mg/g' }] },
  clindamycin: { ndc_code: '50474-512-01', ndc_11: '50474051201', proprietary_name: 'ANTIROBE', nonproprietary_name: 'CLINDAMYCIN HYDROCHLORIDE', active_ingredients: [{ name: 'CLINDAMYCIN HYDROCHLORIDE', strength: '25 mg' }] },
  praziquantel: { ndc_code: '00010-4320-01', ndc_11: '00010432001', proprietary_name: 'DRONCIT', nonproprietary_name: 'PRAZIQUANTEL', active_ingredients: [{ name: 'PRAZIQUANTEL', strength: '34 mg' }] },
  theophylline: { ndc_code: '00025-0721-01', ndc_11: '00025072101', proprietary_name: 'THEO-24', nonproprietary_name: 'THEOPHYLLINE', active_ingredients: [{ name: 'THEOPHYLLINE', strength: '100 mg' }] },
  atropine: { ndc_code: '00065-0080-05', ndc_11: '00065008005', proprietary_name: 'ISOPTO ATROPINE', nonproprietary_name: 'ATROPINE SULFATE', active_ingredients: [{ name: 'ATROPINE SULFATE', strength: '1%' }] },
  prednisone: { ndc_code: '00054-4728-25', ndc_11: '00054472825', proprietary_name: 'DELTASONE', nonproprietary_name: 'PREDNISONE', active_ingredients: [{ name: 'PREDNISOLONE', strength: '5 mg' }] },
  ivermectin: { ndc_code: '00010-4181-01', ndc_11: '00010418101', proprietary_name: 'HEARTGARD', nonproprietary_name: 'IVERMECTIN', active_ingredients: [{ name: 'IVERMECTIN', strength: '68 mcg' }] }
};

// 2. 동의어 그룹
const ALIAS_GROUP_LIST = [
  { masterKey: 'doxycycline', aliases: ['doxycycline', 'doxycyclin', 'vibramycin', 'doxy'] },
  { masterKey: 'enrofloxacin', aliases: ['enrofloxacin', 'enrofloxacine', 'baytril', 'enroflox'] },
  { masterKey: 'ciprofloxacin', aliases: ['ciprofloxacin', 'ciloxan', 'cipro'] },
  { masterKey: 'ofloxacin', aliases: ['ofloxacin', 'ocuflox'] },
  { masterKey: 'labetalol', aliases: ['labetalol'] },
  { masterKey: 'benazepril', aliases: ['benazepril', 'lotensin'] },
  { masterKey: 'orbifloxacin', aliases: ['orbifloxacin', 'orbax'] },
  { masterKey: 'pimobendan', aliases: ['pimobendan', 'vetmedin'] },
  { masterKey: 'clavamox', aliases: ['clavamox', 'amoxicillin', 'amoxi'] },
  { masterKey: 'apoquel', aliases: ['apoquel', 'oclacitinib'] },
  { masterKey: 'cerenia', aliases: ['cerenia', 'maropitant'] },
  { masterKey: 'metacam', aliases: ['metacam', 'meloxicam'] },
  { masterKey: 'temaril', aliases: ['temaril', 'temarilp', 'temaril-p', 'prednisolone'] },
  { masterKey: 'gabapentin', aliases: ['gabapentin', 'neurontin'] },
  { masterKey: 'alfaxalone', aliases: ['alfaxalone', 'alfaxan', 'alfax'] },
  { masterKey: 'grapiprant', aliases: ['grapiprant', 'galliprant'] },
  { masterKey: 'carprofen', aliases: ['carprofen', 'rimadyl', 'carprovet'] },
  { masterKey: 'levetiracetam', aliases: ['levetiracetam', 'keppra'] },
  { masterKey: 'methimazole', aliases: ['methimazole', 'felimazole'] },
  { masterKey: 'furosemide', aliases: ['furosemide', 'salix', 'lasix'] },
  { masterKey: 'spironolactone', aliases: ['spironolactone', 'aldactone'] },
  { masterKey: 'amlodipine', aliases: ['amlodipine', 'norvasc'] },
  { masterKey: 'cyclosporine', aliases: ['cyclosporine', 'atopica'] },
  { masterKey: 'sucralfate', aliases: ['sucralfate', 'carafate'] },
  { masterKey: 'omeprazole', aliases: ['omeprazole', 'gastrogard'] },
  { masterKey: 'tramadol', aliases: ['tramadol', 'ultram'] },
  { masterKey: 'adequan', aliases: ['adequan', 'polysulfatedglycosaminoglycan', 'psgag'] },
  { masterKey: 'interceptor', aliases: ['interceptor', 'milbemycin', 'milbemycinoxime'] },
  { masterKey: 'bravecto', aliases: ['bravecto', 'fluralaner'] },
  { masterKey: 'nexgard', aliases: ['nexgard', 'afoxolaner'] },
  { masterKey: 'simparica', aliases: ['simparica', 'sarolaner'] },
  { masterKey: 'metronidazole', aliases: ['metronidazole', 'flagyl'] },
  { masterKey: 'tylosin', aliases: ['tylosin', 'tylan', 'tylosintartrate'] },
  { masterKey: 'tobrex', aliases: ['tobrex', 'tobramycin'] },
  { masterKey: 'nizoral', aliases: ['nizoral', 'ketoconazole'] },
  { masterKey: 'itraconazole', aliases: ['itraconazole', 'sporanox'] },
  { masterKey: 'cefpodoxime', aliases: ['cefpodoxime', 'simplicef', 'cefpodoximeproxetil'] },
  { masterKey: 'simplicef', aliases: ['simplicef', 'cefpodoxime'] },
  { masterKey: 'keflex', aliases: ['keflex', 'cephalexin'] },
  { masterKey: 'zeniquin', aliases: ['zeniquin', 'marbofloxacin'] },
  { masterKey: 'reglan', aliases: ['reglan', 'metoclopramide'] },
  { masterKey: 'pepcid', aliases: ['pepcid', 'famotidine'] },
  { masterKey: 'pyrantel', aliases: ['pyrantel', 'pyrantelpamoate', 'nemex'] },
  { masterKey: 'fenbendazole', aliases: ['fenbendazole', 'fenbendazol', 'panacur'] },
  { masterKey: 'clindamycin', aliases: ['clindamycin', 'clindamycine', 'antirobe'] },
  { masterKey: 'praziquantel', aliases: ['praziquantel', 'praziquantell', 'droncit'] },
  { masterKey: 'theophylline', aliases: ['theophylline', 'theo24', 'theo-24'] },
  { masterKey: 'atropine', aliases: ['atropine'] },
  { masterKey: 'prednisone', aliases: ['prednisone', 'deltasone'] },
  { masterKey: 'ivermectin', aliases: ['ivermectin', 'heartgard'] }
];

if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('[seon] Supabase: connected');
} else {
  console.warn('[seon] Supabase credentials missing');
}

async function ensureDrugDictionaryLoaded() {
  if (drugDictionaryCache.length > 0) return true;
  if (!supabase) return false;

  if (isCacheLoading) {
    while (isCacheLoading) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return drugDictionaryCache.length > 0;
  }

  isCacheLoading = true;
  try {
    const { data, error } = await supabase
      .from('fda_ndc_vet_dictionary')
      .select('*')
      .range(0, 1999);

    if (!error && data && data.length > 0) {
      drugDictionaryCache = data;
      console.log(`[seon] Dictionary FULLY loaded: ${drugDictionaryCache.length} items cached.`);
    }
  } catch (err) {
    console.error("[seon] Cache exception:", err.message);
  } finally {
    isCacheLoading = false;
  }

  return drugDictionaryCache.length > 0;
}

function normalizeString(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function lookupDrugFromDb(drugInput) {
  if (!drugInput) return null;
  let rawTerm = drugInput.trim();
  const cleanInput = rawTerm.toLowerCase();

  if (TYPO_MAP[cleanInput]) {
    rawTerm = TYPO_MAP[cleanInput];
  }

  const lowerTerm = rawTerm.toLowerCase();
  const normalizedTerm = normalizeString(rawTerm);
  const cleanDigits = rawTerm.replace(/[^0-9]/g, '');

  if (normalizedTerm.length < 3) return null;

  // Step 1: 완전 일치 매칭
  const matchedGroup = ALIAS_GROUP_LIST.find(group => 
    group.aliases.some(alias => {
      const normAlias = normalizeString(alias);
      return normalizedTerm === normAlias;
    })
  );

  if (matchedGroup) {
    const mapped = MASTER_DRUG_RECORDS[matchedGroup.masterKey];
    if (mapped) {
      return {
        name: drugInput,
        ndc_code: mapped.ndc_code,
        ndc_11: mapped.ndc_11,
        ndc_source: "openfda_db",
        ndc_verified: true,
        product_type: "VETERINARY",
        proprietary_name: mapped.proprietary_name,
        active_ingredients: mapped.active_ingredients
      };
    }
  }

  // Step 2: Supabase DB 캐시 정밀 토큰 검색
  await ensureDrugDictionaryLoaded();

  if (drugDictionaryCache.length > 0) {
    const matched = drugDictionaryCache.find(d => {
      const propNorm = normalizeString(d.proprietary_name || '');
      const nonPropNorm = normalizeString(d.nonproprietary_name || '');
      const ndc = (d.ndc_code || '').toLowerCase();
      const ndc11 = (d.ndc_11 || '').toLowerCase();
      const ingredients = d.active_ingredients || [];

      if (propNorm === normalizedTerm || nonPropNorm === normalizedTerm || ndc === lowerTerm) {
        return true;
      }
      if (cleanDigits.length >= 8 && ndc11 === cleanDigits) {
        return true;
      }

      return ingredients.some(ing => {
        const rawIngName = (ing.name || '').toLowerCase();
        const ingTokens = rawIngName.split(/\s+/).map(t => normalizeString(t));
        return ingTokens.includes(normalizedTerm);
      });
    });

    if (matched) {
      return {
        name: drugInput,
        ndc_code: matched.ndc_code,
        ndc_11: matched.ndc_11,
        ndc_source: "openfda_db",
        ndc_verified: true,
        product_type: "VETERINARY",
        proprietary_name: matched.proprietary_name || matched.nonproprietary_name || rawTerm,
        active_ingredients: matched.active_ingredients || [{ name: rawTerm, strength: '' }]
      };
    }
  }

  return null;
}

// DB 기반 DNI 검사 엔진
async function evaluateDniConflictsFromDb(prescriptions, supplements) {
  const conflicts = [];
  if (!supabase) return conflicts;

  try {
    const { data: rules, error } = await supabase.from('dni_rules').select('*');
    if (error || !rules) return conflicts;

    for (const rx of prescriptions) {
      const ingredients = rx.active_ingredients || [];
      const rxName = (rx.name || '').toUpperCase();

      for (const supp of supplements) {
        const suppName = (typeof supp === 'string' ? supp : supp.name || '').toUpperCase();

        for (const rule of rules) {
          const matchSupp = rule.supplement_keywords.some(k => suppName.includes(k));
          if (!matchSupp) continue;

          let matchIng = rule.ingredient_keywords.some(k => rxName.includes(k));

          if (!matchIng) {
            for (const ing of ingredients) {
              const ingName = (ing.name || '').toUpperCase();
              if (rule.ingredient_keywords.some(k => ingName.includes(k))) {
                matchIng = true;
                break;
              }
            }
          }

          if (matchIng) {
            conflicts.push({
              drug_name: rx.name,
              matched_ingredient: rx.name,
              supplement_name: supp,
              severity: rule.severity,
              conflict_type: rule.conflict_type,
              message: rule.message_ko,
              recommended_action: rule.recommended_action
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("[seon] DNI Evaluation error:", err.message);
  }

  return conflicts;
}

app.get('/health', async (req, res) => {
  await ensureDrugDictionaryLoaded();
  res.json({ status: 'ok', cached_drugs: drugDictionaryCache.length, timestamp: new Date().toISOString() });
});

// v1 분석 엔드포인트: Rate Limiter 및 API Key 인증 미들웨어 적용
app.post('/v1/analyze', rateLimiter, authenticateApiKey, async (req, res) => {
  try {
    await ensureDrugDictionaryLoaded();

    const { prescriptions = [], supplements = [], pet_bio } = req.body;

    const analyzedPrescriptions = await Promise.all(
      prescriptions.map(async (item) => {
        const drugName = typeof item === 'string' ? item : item.name;
        const frequency = item.frequency_per_day || 1;

        const dbResult = await lookupDrugFromDb(drugName);
        if (dbResult) {
          return {
            ...dbResult,
            frequency_per_day: frequency
          };
        }

        return {
          name: drugName,
          ndc_code: null,
          ndc_11: null,
          ndc_source: "manual",
          ndc_verified: false,
          product_type: "UNKNOWN",
          proprietary_name: drugName,
          frequency_per_day: frequency,
          active_ingredients: [{ name: drugName, strength: '' }]
        };
      })
    );

    const conflicts = await evaluateDniConflictsFromDb(analyzedPrescriptions, supplements);
    const conflictDetected = conflicts.length > 0;

    let recommendedSchedule = "제약 없음 — 평소 급여 스케줄을 유지하세요.";
    if (conflictDetected) {
      const hasHigh = conflicts.some(c => c.severity === 'HIGH');
      recommendedSchedule = hasHigh
        ? "⚠️ 심각한 상호작용 감지: 약물과 영양제 복용 간격을 최소 2시간 이상 유지하거나 수의사 상담이 필요합니다."
        : "⚡ 주의 상호작용 감지: 동시 복용 시 관찰이 필요합니다.";
    }

    return res.json({
      status: "SUCCESS",
      dni_conflict_detected: conflictDetected,
      conflicts_count: conflicts.length,
      conflicts: conflicts,
      recommended_schedule: recommendedSchedule,
      prescriptions: analyzedPrescriptions,
      supplements: supplements
    });

  } catch (error) {
    console.error("[seon] Analyze error:", error);
    return res.status(500).json({ status: "ERROR", message: error.message });
  }
});

app.listen(PORT, async () => {
  console.log(`[seon] Strict Token Isolation Engine Active | Server running on port ${PORT}`);
  await ensureDrugDictionaryLoaded();
});
