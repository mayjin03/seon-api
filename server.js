#!/usr/bin/env node
'use strict';
/* ============================================================================
   SEON (서온) · Standalone B2B API Server
   ----------------------------------------------------------------------------
   POST /v1/analyze  — Pet Bio + Prescriptions + Supplements  ->  B2B RAW JSON
   GET  /health      — liveness probe

   실행:   npm install && npm start            (기본 포트 3000)
   호출:   curl -X POST http://localhost:3000/v1/analyze \
             -H "X-SEON-API-KEY: seon_demo_pk_sandbox_key" -H "Content-Type: application/json" \
             -d '{"pet_bio":{"breed":"말티즈","weight_kg":4.2,"age_years":10,"bcs":5,"conditions":["kidney"]},
                  "prescriptions":[{"name":"Enrofloxacin","frequency_per_day":2}],
                  "supplements":["칼슘/킬레이트 칼슘"]}'

   환경 변수 (모두 선택)
     PORT                 리스닝 포트 (기본 3000)
     CORS_ORIGIN          허용 Origin, 콤마로 여러 개 (기본 * = 전체 허용)
     SEON_API_KEYS        프로덕션 API Key 목록, 콤마 구분 (예: key_a,key_b)
     ALLOW_DEMO_KEYS      'false'면 seon_demo_pk_ 로 시작하는 Sandbox 키를 거부 (기본 허용)
     RATE_LIMIT_PER_MIN   키당 분당 요청 한도 (기본 60)
     BODY_LIMIT           JSON 본문 최대 크기 (기본 100kb)

   연산 엔진에 대하여
     아래 'SEON ENGINE' 블록은 서온 웹앱(dogdiet-plan.html)의 실제 연산 코드
     (computeHealthScore · computeOrganBurden · DNI_MOLECULE_RULES · Sandbox 브리지)를
     구문 분석기(acorn)로 '그대로' 추출한 것이에요. 다시 작성한 근사 로직이 아니라서,
     같은 요청에 대해 Live API Sandbox와 동일한 값을 반환해요(34개 케이스로 대조 검증).
     웹앱의 엔진 코드를 바꾸면 이 블록도 다시 추출해야 값이 어긋나지 않아요.
     이 블록은 직접 손으로 고치지 마세요.

   ※ 모든 출력은 진단·처방을 대체하지 않는 비진단(Non-Diagnostic) 의사결정 보조 신호예요.
   ※ ndc_code 는 데모용 예시 매핑이에요(공인 NDC 디렉터리 조회가 아님).
============================================================================ */
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

/* ================= SEON ENGINE (웹앱에서 추출 · 수정 금지) ================= */
const ENGINE = (function(){
  const dog = {
    plan:null,
    sessionId: null, // 이 진단 세션의 고유 식별자 — DB UPSERT 충돌키로 써서 같은 진단이 두 행으로 중복 저장되지 않게 해요.
    name:"", breed:"", ageYear:"", ageMonth:"",
    weight:null, target:null, neutered:null, bcs:null, conditions:[],
    walk:null, weeklyWalkFreq:null, activity:null, foodKcal:null, foodBrandLabel:"", foodProductName:"", foodTexture:null,
    feedFreqCurrent:null, feedAmountCurrent:null,
    dynamic:{}, supplements:[], snacks:{},
    // ---- B2B 데이터 가치 강화 (Step5: 생활패턴·임상징후·병력·니즈/예산) ----
    jointSigns:[], digestiveSigns:[], skinSigns:[], waterIntakeStatus:null,
    vetVisitPurpose:null, diagnosedHistory:[], onMedication:null,
    topConcern:null, monthlyBudget:null,
  };

  const MAIN_BREED_RISK_PENALTY = {
    "닥스훈트":4, "프렌치불독":4, "골든리트리버":3, "래브라도리트리버":3, "웰시코기":3,
    "코카스파니엘":2, "시베리안허스키":2, "사모예드":2, "말티즈":2, "포메라니안":2,
    "요크셔테리어":2, "비숑프리제":2, "시츄":2, "비글":2, "잭러셀테리어":1, "진돗개":1, "보더콜리":1,
  };

  function computeHealthScore(r){
    let score = 100;
    score -= Math.abs(dog.bcs - 5) * 9; // 이상 체형(BCS 5)에서 멀수록 감점
    if(dog.conditions.length && !dog.conditions.includes('none')) score -= dog.conditions.length * 6;
    if(r.allocation.snackRatio > 0.10) score -= 10;
    if(r.allocation.supplementRatio > 0.10) score -= 5;
    // ⚠️ 이전에는 나이/품종/건강목표가 스코어 계산에 전혀 반영되지 않아서, 같은 BCS·질환 수를 가진
    // 1세 강아지와 12세 노령견이 동일한 점수를 받는 문제가 있었어요.
    // ---- 나이(Age): 노령견은 장기 예비력(organ reserve)이 낮아 동일 조건에서도 리스크가 더 커요 ----
    const ageYear = dog.ageYear || 0;
    if(ageYear >= 10) score -= 8;
    else if(ageYear >= 7) score -= 4;
    // ---- 품종(Breed): 대표적인 호발 소인을 소폭 반영해요(참고용) ----
    score -= (MAIN_BREED_RISK_PENALTY[dog.breed] || 0);
    // ---- 건강 목표(Goal): 구체적인 케어 플랜을 설정한 것 자체가 능동적 관리 신호라 소폭 가점해요 ----
    if(dog.plan && dog.plan !== 'general') score += 3;
    score = Math.max(15, Math.min(100, Math.round(score)));
    const light = score>=75 ? 'green' : score>=50 ? 'yellow' : 'red';
    const verdictMap = {
      green: '전반적으로 양호한 상태예요',
      yellow: '몇 가지 관리가 필요해요',
      red: '적극적인 케어가 필요한 상태예요',
    };
    return { score, light, verdict: verdictMap[light] };
  }

  const DRUG_MOLECULES_BY_CATEGORY = {
    diuretic:       ["Furosemide", "Spironolactone", "Torsemide"],
    antibiotic:     ["Enrofloxacin", "Amoxicillin", "Cephalexin", "Metronidazole"],
    steroid:        ["Prednisolone", "Dexamethasone", "Methylprednisolone"],
    joint_med:      ["Polysulfated GAG (Adequan)", "Bedinvetmab (Librela)", "Pentosan Polysulfate"],
    cardiac:        ["Pimobendan", "Benazepril", "Amlodipine"],
    anticonvulsant: ["Phenobarbital", "Potassium Bromide", "Levetiracetam"],
    anticoagulant:  ["Warfarin", "Clopidogrel", "Rivaroxaban"],
    gi:             ["Omeprazole", "Famotidine", "Metoclopramide", "Sucralfate"],
    nsaid:          ["Carprofen", "Meloxicam", "Firocoxib", "Robenacoxib"],
    immuno_skin:    ["Cyclosporine", "Oclacitinib (Apoquel)", "Lokivetmab (Cytopoint)"],
    hormone:        ["Levothyroxine", "Trilostane", "Insulin Glargine"],
    other:          [],
  };

  const META_BREED_DB = [
    { id:"maltese",          label:"말티즈",       size:"소형",   kidneySensitivity:1.15, liverSensitivity:1.0,  note:"소형견 - 림프/신장 민감성 높음" },
    { id:"pomeranian",       label:"포메라니안",   size:"소형",   kidneySensitivity:1.15, liverSensitivity:1.0,  note:"소형견 - 림프/신장 민감성 높음" },
    { id:"poodle_toy",       label:"토이푸들",     size:"소형",   kidneySensitivity:1.1,  liverSensitivity:1.0,  note:"소형견 - 신장 민감성 다소 높음" },
    { id:"chihuahua",        label:"치와와",       size:"소형",   kidneySensitivity:1.15, liverSensitivity:1.0,  note:"소형견 - 신장 민감성 높음" },
    { id:"shihtzu",          label:"시츄",         size:"소형",   kidneySensitivity:1.1,  liverSensitivity:1.0,  note:"소형견 - 신장 민감성 다소 높음" },
    { id:"bichon",           label:"비숑프리제",   size:"소형",   kidneySensitivity:1.1,  liverSensitivity:1.0,  note:"소형견 - 신장 민감성 다소 높음" },
    { id:"welsh_corgi",      label:"웰시코기",     size:"중형",   kidneySensitivity:1.0,  liverSensitivity:1.0,  note:"중형견 - 평균적 대사 특성" },
    { id:"beagle",           label:"비글",         size:"중형",   kidneySensitivity:1.0,  liverSensitivity:1.0,  note:"중형견 - 평균적 대사 특성" },
    { id:"jindo",            label:"진돗개",       size:"중형",   kidneySensitivity:0.95, liverSensitivity:1.0,  note:"중형견 - 신장 여유도 다소 높음" },
    { id:"poodle_standard",  label:"스탠다드푸들", size:"중형",   kidneySensitivity:1.0,  liverSensitivity:1.0,  note:"중형견 - 평균적 대사 특성" },
    { id:"golden_retriever", label:"골든리트리버", size:"대형",   kidneySensitivity:0.95, liverSensitivity:1.1,  note:"대형견 - 단백질 대사 부담이 간에 다소 높게 반영됨" },
    { id:"labrador",         label:"래브라도리트리버", size:"대형", kidneySensitivity:0.95, liverSensitivity:1.05, note:"대형견 - 단백질 대사 특성 반영" },
    { id:"great_dane",       label:"그레이트데인", size:"초대형", kidneySensitivity:0.9,  liverSensitivity:1.0,  note:"초대형견 - 체중당 대사 여유도 높음" },
    { id:"saint_bernard",    label:"세인트버나드", size:"초대형", kidneySensitivity:0.9,  liverSensitivity:1.0,  note:"초대형견 - 체중당 대사 여유도 높음" },
    { id:"other",            label:"기타(직접입력)", size:null,   kidneySensitivity:1.0,  liverSensitivity:1.0,  note:"" },
  ];

  const META_AGE_GROUPS = [
    { id:"young", label:"어린/성장기", capacityFactor:1.0 },
    { id:"adult", label:"성견", capacityFactor:1.0 },
    { id:"senior", label:"노령견(Senior)", capacityFactor:1.25 },
  ];

  const META_CONDITION_SEVERITY = {
    kidney: [
      { id:"mild",     label:"주의/초기",           capacityReduction:0.30, extraBurden:15 },
      { id:"ckd_1_2",  label:"CKD 1~2단계",         capacityReduction:0.50, extraBurden:35 },
      { id:"ckd_3_4",  label:"CKD 3~4단계(중증)",   capacityReduction:0.70, extraBurden:60 },
    ],
    liver: [
      { id:"alt_alp",           label:"간수치 단순 상승(ALT/ALP)", capacityReduction:0.20, extraBurden:15 },
      { id:"chronic_hepatitis", label:"만성 간염/담낭 슬러지",     capacityReduction:0.45, extraBurden:35 },
      { id:"cirrhosis",         label:"간경화/간부전",             capacityReduction:0.65, extraBurden:55 },
    ],
    heart: [
      { id:"stage_ab1", label:"ACVIM A~B1단계",       sodiumSensitivity:1.2, extraBurden:5  },
      { id:"stage_b2",  label:"B2단계(약물 복용)",     sodiumSensitivity:1.5, extraBurden:15 },
      { id:"stage_cd",  label:"C~D단계(이뇨제/부종)", sodiumSensitivity:2.0, extraBurden:30 },
    ],
    joint: [
      { id:"mild", label:"경증", extraBurden:0 },
      { id:"moderate", label:"중등도", extraBurden:5 },
      { id:"severe", label:"중증/급성", extraBurden:10 },
    ],
    skin: [
      { id:"mild", label:"경증", extraBurden:2 },
      { id:"moderate", label:"중등도", extraBurden:8 },
      { id:"severe", label:"중증/급성", extraBurden:15 },
    ],
  };

  const META_CONDITIONS = [
    { id:"kidney", label:"신장 질환/주의", organ:"kidney" },
    { id:"liver",  label:"간 질환/주의",   organ:"liver"  },
    { id:"heart",  label:"심장 질환",      organ:"heart"  },
    { id:"joint",  label:"관절 질환",      organ:"none"   },
    { id:"skin",   label:"피부/알레르기",  organ:"none"   },
  ];

  const META_MULTIMORBIDITY_COMBOS = [
    { pair:["kidney","heart"], liverMult:1.10, kidneyMult:1.30, note:"신장+심장 질환 동반 — 체액·나트륨 배출 부담이 상호 증폭돼요." },
    { pair:["kidney","liver"], liverMult:1.25, kidneyMult:1.25, note:"신장+간 질환 동반 — 대사·배설 경로가 겹쳐 부담이 상호 증폭돼요." },
    { pair:["liver","heart"],  liverMult:1.15, kidneyMult:1.10, note:"간+심장 질환 동반 — 약물 대사 및 순환 부담이 상호 증폭돼요." },
  ];

  const META_CONDITION_MED_SYNERGY = [
    { conditionOrgan:"kidney", medCategories:["nsaid","diuretic"], liverMult:1.05, kidneyMult:1.35, note:"신장 질환 상태에서 신장 배설 위주 약물(NSAIDs/이뇨제) 복용 시 상호작용 부담이 커져요." },
    { conditionOrgan:"liver",  medCategories:["nsaid","steroid"],  liverMult:1.35, kidneyMult:1.05, note:"간 질환 상태에서 간 대사 위주 약물(NSAIDs/스테로이드) 복용 시 상호작용 부담이 커져요." },
  ];

  const META_ACTIVITY_LEVELS = [
    { id:"low",     label:"😴 실내 위주/저활동", desc:"산책 30분 미만, 누워있는 시간이 많음", burdenFactor:1.10, derFactor:0.90 },
    { id:"normal",  label:"🐕 보통 활동",        desc:"일일 30분~1시간 정기 산책",             burdenFactor:1.00, derFactor:1.00 },
    { id:"active",  label:"🏃 왕성한 활동",      desc:"일일 1~2시간 이상 야외 활동",           burdenFactor:0.95, derFactor:1.15 },
    { id:"working", label:"⚡ 작업견/극왕성",     desc:"스포츠견/작업견 등",                     burdenFactor:0.90, derFactor:1.30 },
  ];

  const metaHealthProfile = {
    name: "",
    breed: "maltese",
    breedOtherSize: "중형",
    weight: 5.0,
    ageGroup: "adult",
    activityLevel: "normal",
    conditions: {},
    bloodwork: { kidneyNormal: null, liverNormal: null },
  };

  META_CONDITIONS.forEach(c=>{ metaHealthProfile.conditions[c.id] = { active:false, severity: (META_CONDITION_SEVERITY[c.id]||[{id:'mild'}])[0].id }; });

  function metaGetActivityLevel(){
    return META_ACTIVITY_LEVELS.find(a=>a.id===metaHealthProfile.activityLevel) || META_ACTIVITY_LEVELS[1];
  }

  const META_TREAT_TYPES = [
    { id:"jerky",        label:"육포/포류(고단백/고나트륨)",   unitLabel:"개비", gramsPerUnit:10, kcalPer100g:350, proteinPct:55, fatPct:10, sodiumMg100g:500, phosphorusMg100g:450 },
    { id:"freeze_dried",  label:"동결건조 트릿",               unitLabel:"개",   gramsPerUnit:2,  kcalPer100g:400, proteinPct:50, fatPct:20, sodiumMg100g:300, phosphorusMg100g:500 },
    { id:"churu",         label:"츄르/짜먹는 간식(고수분)",    unitLabel:"개",   gramsPerUnit:14, kcalPer100g:70,  proteinPct:5,  fatPct:2,  sodiumMg100g:200, phosphorusMg100g:150 },
    { id:"dental_chew",   label:"덴탈츄/껌류",                 unitLabel:"개",   gramsPerUnit:15, kcalPer100g:350, proteinPct:40, fatPct:5,  sodiumMg100g:150, phosphorusMg100g:300 },
    { id:"veggie_fruit",  label:"야채/과일류(저단백/저칼로리)", unitLabel:"조각", gramsPerUnit:10, kcalPer100g:40,  proteinPct:2,  fatPct:0.5,sodiumMg100g:5,   phosphorusMg100g:20  },
  ];

  const metaFoodInput = {
    type: "dry",
    inputMode: "preset",   // 'brand' | 'preset' | 'manual' — 5개 제형 모두 동일하게 3가지 모드를 제공해요.
    selectedBrandId: "",
    selectedPresetId: "dry_standard",
    kcalPerKg: 3650, proteinPct: 26, fatPct: 15, sodiumMg100g: 300, phosphorusMg100g: 900, moisturePct: 10,
    calciumMg100g: 15,  // 순살(뼈 없는) 근육육 기준 통상치 — '뼈 포함' 부재료 선택 시 크게 올라가요.
    potassiumMg100g: 350, // 육류 100g당 통상적인 칼륨 함량
    dailyG: 100, freqPerDay: 2,
    mixins: { egg:{active:false,pct:10}, veggie:{active:false,pct:15}, grain:{active:false,pct:10}, bone:{active:false,pct:20} }, // 화식/생식 부재료 — 주 육류 대비 상대 비율(%) (뼈 포함은 생식 전용)
    treatType: "jerky", treatUnitMode: "count", treatQuantity: 0,
  };

  const META_HOMEMADE_MIXINS = [
    { id:"egg",    label:"🥚 달걀/계란 노른자",      defaultPct:10, maxPct:30, proteinPctBonusAt100:15,    fatPctBonusAt100:10,    phosphorusMg100gBonusAt100:150, calciumMg100gBonusAt100:50 },
    { id:"veggie", label:"🥦 야채/채소 믹스",        defaultPct:15, maxPct:40, proteinPctBonusAt100:-6.67, fatPctBonusAt100:-3.33, potassiumMg100gBonusAt100:266.67 },
    { id:"grain",  label:"🌾 곡류/탄수화물",         defaultPct:10, maxPct:30, proteinPctBonusAt100:-20,   fatPctBonusAt100:-10,   phosphorusMg100gBonusAt100:100 },
    { id:"bone",   label:"🦴 뼈 포함(생식 전용)",     defaultPct:20, maxPct:40, calciumMg100gBonusAt100:400, phosphorusMg100gBonusAt100:200 },
  ];

  const META_SUPPLEMENT_CATEGORIES = [
    { id:"joint",          label:"관절/연골", presets:[
      { id:"gcm", label:"글루코사민/콘드로이친/MSM", calciumMg:150, phosphorusMg:80, sodiumMg:5, vitAiu:0, vitDiu:0, omega3Mg:0,
        components:[{label:"글루코사민", amount:300, unit:"mg"},{label:"콘드로이친", amount:150, unit:"mg"},{label:"MSM", amount:200, unit:"mg"}] },
      { id:"collagen", label:"콜라겐 기반", calciumMg:100, phosphorusMg:60, sodiumMg:5, vitAiu:0, vitDiu:0, omega3Mg:0,
        components:[{label:"가수분해 콜라겐", amount:500, unit:"mg"}] },
    ]},
    { id:"gut",            label:"유산균/장", presets:[
      { id:"probiotic_standard", label:"프로바이오틱스(표준)", calciumMg:20, phosphorusMg:10, sodiumMg:2, vitAiu:0, vitDiu:0, omega3Mg:0,
        components:[{label:"유산균", amount:1, unit:"억 CFU"}] },
    ]},
    { id:"skin",           label:"피부/모질", presets:[
      { id:"omega_biotin", label:"오메가3+비오틴", calciumMg:0, phosphorusMg:0, sodiumMg:0, vitAiu:0, vitDiu:0, omega3Mg:400,
        components:[{label:"오메가3(EPA+DHA)", amount:400, unit:"mg"},{label:"비오틴", amount:50, unit:"mcg"}] },
    ]},
    { id:"eye",            label:"눈/눈물",   presets:[
      { id:"lutein_bilberry", label:"루테인/빌베리", calciumMg:0, phosphorusMg:0, sodiumMg:0, vitAiu:200, vitDiu:0, omega3Mg:0,
        components:[{label:"루테인", amount:10, unit:"mg"},{label:"빌베리 추출물", amount:50, unit:"mg"}] },
    ]},
    { id:"kidney_bladder", label:"신장/방광", presets:[
      { id:"cranberry_electrolyte", label:"크랜베리/전해질 조절", calciumMg:30, phosphorusMg:20, sodiumMg:15, vitAiu:0, vitDiu:0, omega3Mg:0,
        components:[{label:"크랜베리 추출물", amount:200, unit:"mg"}] },
    ]},
    { id:"multivitamin",   label:"종합비타민", presets:[
      { id:"multivit_standard", label:"지용성비타민A/D+미네랄(표준)", calciumMg:150, phosphorusMg:100, sodiumMg:10, potassiumMg:20, vitAiu:500, vitDiu:250, omega3Mg:100, proteinMg:50,
        components:[
          {label:"비타민A", amount:500, unit:"IU"}, {label:"비타민D", amount:250, unit:"IU"},
          {label:"칼슘", amount:150, unit:"mg"}, {label:"인", amount:100, unit:"mg"},
          {label:"나트륨", amount:10, unit:"mg"}, {label:"칼륨", amount:20, unit:"mg"},
          {label:"단백질/아미노산", amount:50, unit:"mg"},
        ] },
    ]},
    { id:"omega3",         label:"오메가3",   presets:[
      { id:"epa_dha_standard", label:"EPA/DHA(표준)", calciumMg:0, phosphorusMg:0, sodiumMg:0, vitAiu:0, vitDiu:0, omega3Mg:400,
        components:[{label:"EPA+DHA", amount:400, unit:"mg"}] },
    ]},
  ];

  function metaEnsureCategoryState(stateMap, catId){
    if(!stateMap[catId]){
      const def = META_SUPPLEMENT_CATEGORIES.find(c=>c.id===catId);
      stateMap[catId] = { active:false, dosePerAdmin:1, freqPerDay:1, formulation:'tablet', presetId: def ? def.presets[0].id : null, customComponents:null, editOpen:false };
    }
    return stateMap[catId];
  }

  const metaSupplementState = {};

  META_SUPPLEMENT_CATEGORIES.forEach(c=>metaEnsureCategoryState(metaSupplementState, c.id));

  const META_COMPONENT_TO_CALC_FIELD = {
    "비타민A": "vitAiu", "비타민D": "vitDiu", "칼슘": "calciumMg", "인": "phosphorusMg",
    "나트륨": "sodiumMg", "칼륨": "potassiumMg", "단백질/아미노산": "proteinMg",
    "오메가3(EPA+DHA)": "omega3Mg", "EPA+DHA": "omega3Mg",
  };

  function metaGetSupplementPreset(catId){
    const def = META_SUPPLEMENT_CATEGORIES.find(c=>c.id===catId);
    if(!def) return null;
    const state = metaSupplementState[catId];
    return def.presets.find(p=>p.id===(state&&state.presetId)) || def.presets[0];
  }

  function metaGetEffectiveComponents(catId){
    const preset = metaGetSupplementPreset(catId);
    if(!preset) return [];
    const state = metaSupplementState[catId];
    const overrides = state && state.customComponents;
    return (preset.components || []).map(c=>({ ...c, amount: (overrides && overrides[c.label] !== undefined) ? overrides[c.label] : c.amount }));
  }

  function metaGetEffectiveCalcFields(catId){
    const preset = metaGetSupplementPreset(catId);
    if(!preset) return {};
    const fields = { calciumMg:preset.calciumMg, phosphorusMg:preset.phosphorusMg, sodiumMg:preset.sodiumMg, potassiumMg:preset.potassiumMg||0, vitAiu:preset.vitAiu, vitDiu:preset.vitDiu, omega3Mg:preset.omega3Mg, proteinMg:preset.proteinMg||0 };
    metaGetEffectiveComponents(catId).forEach(c=>{
      const field = META_COMPONENT_TO_CALC_FIELD[c.label];
      if(field) fields[field] = c.amount;
    });
    return fields;
  }

  const META_MEDICATION_CATEGORIES = [
    { id:"antibiotic", label:"항생제" },
    { id:"nsaid",      label:"NSAIDs 소염진통제" },
    { id:"steroid",    label:"스테로이드" },
    { id:"diuretic",   label:"이뇨제" },
    { id:"cardiac",    label:"심장약" },
    { id:"other",      label:"기타 처방약" },
  ];

  const ORGAN_LOAD_BY_MED_CATEGORY = {
    antibiotic: { liver:14, kidney:12 },
    nsaid:      { liver:16, kidney:18 },
    steroid:    { liver:20, kidney:8  },
    diuretic:   { liver:6,  kidney:22 },
    cardiac:    { liver:10, kidney:14 },
    other:      { liver:6,  kidney:6  },
  };

  const META_DRUG_AGENTS_BY_CATEGORY = {
    nsaid: [
      { id:"meloxicam", label:"멜록시캄(Meloxicam)", liver:14, kidney:20 },
      { id:"carprofen", label:"카프로펜(Carprofen)", liver:18, kidney:16 },
    ],
    steroid: [
      { id:"prednisolone", label:"프레드니솔론(Prednisolone)", liver:24, kidney:6 },
    ],
    diuretic: [
      { id:"furosemide", label:"푸로세미드(Furosemide)", liver:5, kidney:26 },
    ],
    antibiotic: [
      { id:"amoxicillin", label:"아목시실린(Amoxicillin)", liver:10, kidney:14 },
      { id:"cephalexin",  label:"세팔렉신(Cephalexin)",   liver:8,  kidney:16 },
    ],
    cardiac: [
      { id:"pimobendan", label:"피모벤단(Pimobendan)", liver:12, kidney:10 },
    ],
    other: [],
  };

  const META_FORMULATION_PEAK_MULTIPLIER = {
    tablet:    { label:"💊 알약(정제/캡슐)",     multiplier:1.0  },
    powder:    { label:"🧂 가루약(조제분말/포)", multiplier:1.25 },
    liquid:    { label:"🧪 액상/시럽(mL)",       multiplier:1.3  },
    injection: { label:"💉 주사/기타",           multiplier:1.4  },
  };

  const META_STANDARD_DOSAGE_MG_PER_KG_PER_DAY = {
    antibiotic: 20, nsaid: 0.2, steroid: 0.5, diuretic: 2, cardiac: 0.25, other: 5,
  };

  function metaComputeMedicationDoseFactor(entry, weight){
    if(entry.formulation !== 'powder' && entry.formulation !== 'liquid'){
      // ⚠️ 이전에는 정제(tablet)/주사(injection) 제형에 체중 보정이 전혀 없어서, 3kg 소형견과
      // 40kg 대형견이 똑같이 '1정'을 먹어도 항상 동일한 부하로 계산됐어요(체중/BSA 미반영).
      // 분말/액상과 같은 방향으로, 10kg을 기준으로 약하게(0.85~1.2배로 좁게 제한) 보정해요 —
      // 기존 검증된 계산 결과들이 크게 흔들리지 않도록 영향력을 최소화했어요.
      const weightNormFactor = Math.max(0.85, Math.min(1.2, weight / 10));
      return (entry.dosePerAdmin||1) * weightNormFactor;
    }
    const stdMgPerKgDay = META_STANDARD_DOSAGE_MG_PER_KG_PER_DAY[entry.category] || META_STANDARD_DOSAGE_MG_PER_KG_PER_DAY.other;
    if(entry.knownDoseMg && entry.knownDoseMg > 0){
      const stdDailyMg = weight * stdMgPerKgDay;
      const stdPerAdminMg = stdDailyMg / Math.max(1, entry.freqPerDay||1);
      return Math.max(0.25, Math.min(4, entry.knownDoseMg / Math.max(0.01, stdPerAdminMg)));
    }
    return Math.max(0.5, Math.min(2.5, weight / 10));
  }

  const META_CONDITION_TO_MED_CATEGORY = {
    joint_pain: { label:"슬개골/관절염", category:"nsaid", organRoute:"간 대사 위주 (일부 신장 배설)",
      severities:[ { id:"mild", label:"경증(단기 소염제)", multiplier:1.0 }, { id:"moderate", label:"중등도(장기 NSAIDs)", multiplier:1.3 }, { id:"severe", label:"중증/급성(고용량)", multiplier:1.6 } ] },
    skin: { label:"피부염", category:"steroid", organRoute:"간 대사 위주",
      severities:[ { id:"mild", label:"경증(단기 항히스타민)", multiplier:1.0, categoryOverride:"other" }, { id:"moderate", label:"중등도/만성(스테로이드/아포퀠)", multiplier:1.3 }, { id:"severe", label:"중증/급성(고용량 면역억제제)", multiplier:1.7 } ] },
    ear: { label:"귓병", category:"antibiotic", organRoute:"간 대사 후 신장 배설",
      severities:[ { id:"mild", label:"경증", multiplier:1.0 }, { id:"moderate", label:"중등도", multiplier:1.2 }, { id:"severe", label:"중증", multiplier:1.4 } ] },
    bladder: { label:"방광염/결석", category:"antibiotic", organRoute:"신장 배설 위주",
      severities:[ { id:"mild", label:"단기 방광염(항생제)", multiplier:1.0 }, { id:"moderate", label:"재발성/결석(전해질/조절제)", multiplier:1.4, categoryOverride:"diuretic" }, { id:"severe", label:"중증/폐색", multiplier:1.8 } ] },
    heart_disease: { label:"심장병", category:"cardiac", organRoute:"신장 배설 위주 (이뇨제 병용 흔함)",
      severities:[ { id:"mild", label:"ACVIM A~B1", multiplier:1.0 }, { id:"moderate", label:"B2(약물 복용)", multiplier:1.3, categoryOverride:"cardiac" }, { id:"severe", label:"C~D(이뇨제/부종)", multiplier:1.7, categoryOverride:"diuretic" } ] },
  };

  const metaLoadInput = {
    sessionId: null,
    medicationInputMode: "manual", // 'manual' | 'infer'
    medicationEntries: [],         // 직접 선택 모드: [{id, category, agent, formulation, freqPerDay, dosePerAdmin}]
    inferredConditions: {},        // 복수 선택 가능: { [conditionKey]: {active, severity, dosePerAdmin, freqPerDay} }
  };

  Object.keys(META_CONDITION_TO_MED_CATEGORY).forEach(k=>{
    metaLoadInput.inferredConditions[k] = { active:false, severity: META_CONDITION_TO_MED_CATEGORY[k].severities[0].id, dosePerAdmin:1, freqPerDay:1, formulation:'tablet', knownDoseMg:null };
  });

  function metaNewMedicationEntry(overrides){
    return Object.assign({ id: 'mmed_' + Math.random().toString(36).slice(2,9), category:'antibiotic', agent:'', formulation:'tablet', freqPerDay:1, dosePerAdmin:1, knownDoseMg:null }, overrides||{});
  }

  function metaGetAgentWeight(category, agentId){
    const list = META_DRUG_AGENTS_BY_CATEGORY[category] || [];
    const agent = list.find(a=>a.id===agentId);
    return agent ? { liver:agent.liver, kidney:agent.kidney } : (ORGAN_LOAD_BY_MED_CATEGORY[category] || ORGAN_LOAD_BY_MED_CATEGORY.other);
  }

  function metaGetEffectiveFoodMacros(){
    // 5개 제형 전부 브랜드/프리셋/직접입력 3가지 모드로 동일하게 채워진 metaFoodInput 값을 그대로 써요.
    let proteinPct = metaFoodInput.proteinPct, fatPct = metaFoodInput.fatPct;
    let sodiumMg100g = metaFoodInput.sodiumMg100g, phosphorusMg100g = metaFoodInput.phosphorusMg100g;
    let calciumMg100g = metaFoodInput.calciumMg100g ?? 15, potassiumMg100g = metaFoodInput.potassiumMg100g ?? 350;

    // 화식/생식 부재료(Mix-in) — 입력한 '주 육류 대비 상대 비율(%)'에 선형 비례해서
    // 조단백/조지방(%) 및 미네랄(mg/100g)이 보정돼요. (안전 가드: state가 없거나 손상돼도 죽지 않게)
    const isHomemadeOrRaw = metaFoodInput.type === 'homemade' || metaFoodInput.type === 'raw';
    if(isHomemadeOrRaw && metaFoodInput.mixins){
      META_HOMEMADE_MIXINS.forEach(m=>{
        const state = metaFoodInput.mixins[m.id];
        if(!state || typeof state !== 'object' || !state.active) return;
        if(m.id === 'bone' && metaFoodInput.type !== 'raw') return; // 뼈 포함은 생식 전용
        const ratio = Math.max(0, Math.min(1, (Number(state.pct) || 0) / 100));
        proteinPct += (m.proteinPctBonusAt100 || 0) * ratio;
        fatPct += (m.fatPctBonusAt100 || 0) * ratio;
        phosphorusMg100g += (m.phosphorusMg100gBonusAt100 || 0) * ratio;
        calciumMg100g += (m.calciumMg100gBonusAt100 || 0) * ratio;
        potassiumMg100g += (m.potassiumMg100gBonusAt100 || 0) * ratio;
      });
    }
    return {
      proteinPct: Math.max(0, proteinPct), fatPct: Math.max(0, fatPct),
      sodiumMg100g, phosphorusMg100g: Math.max(0, phosphorusMg100g),
      calciumMg100g: Math.max(0, calciumMg100g), potassiumMg100g: Math.max(0, potassiumMg100g),
    };
  }

  function metaGetActiveTreatType(){ return META_TREAT_TYPES.find(t=>t.id===metaFoodInput.treatType) || META_TREAT_TYPES[0]; }

  function metaGetTreatGrams(){
    const treatType = metaGetActiveTreatType();
    const qty = metaFoodInput.treatQuantity || 0;
    return metaFoodInput.treatUnitMode === 'gram' ? qty : qty * treatType.gramsPerUnit;
  }

  function metaGetEffectiveBreed(){ return META_BREED_DB.find(b=>b.id===metaHealthProfile.breed) || META_BREED_DB[META_BREED_DB.length-1]; }

  function computeMetaNutrientTotals(){
    const macros = metaGetEffectiveFoodMacros();
    const foodG = metaFoodInput.dailyG || 0;
    const foodFactor = foodG / 100;
    let totalProteinG = foodFactor * macros.proteinPct;
    let totalSodiumMg = foodFactor * macros.sodiumMg100g;
    let totalPhosphorusMg = foodFactor * macros.phosphorusMg100g;
    // 사료(및 부재료 보정) 자체의 칼슘/칼륨 기여분 — 이전에는 영양제에서만 집계되고 사료 쪽은
    // 누락돼 있어서, '뼈 포함' 등 부재료 선택이 Ca:P 비율에 실제로 반영되지 않았어요.
    let totalCalciumMg = foodFactor * macros.calciumMg100g;
    let totalPotassiumMg = foodFactor * macros.potassiumMg100g;
    let totalVitAiu = 0, totalVitDiu = 0, totalOmega3Mg = 0;

    // 간식: 제형별 100g당 밀도(kcal/단백/지방/나트륨/인)를 사료와 동일한 방식으로 합산해요.
    // [개수] 입력이면 제형별 1개당 평균 질량(g)으로 먼저 환산한 뒤 계산해요.
    const treatType = metaGetActiveTreatType();
    const treatG = metaGetTreatGrams();
    const treatFactor = treatG / 100;
    const treatKcal = treatFactor * treatType.kcalPer100g;
    totalProteinG += treatFactor * treatType.proteinPct;
    totalSodiumMg += treatFactor * treatType.sodiumMg100g;
    totalPhosphorusMg += treatFactor * treatType.phosphorusMg100g;

    Object.entries(metaSupplementState).forEach(([cat, s])=>{
      if(!s.active) return;
      const preset = metaGetSupplementPreset(cat);
      if(!preset) return;
      const fields = metaGetEffectiveCalcFields(cat); // customComponents 편집값이 있으면 그 값을 우선 사용
      const units = (s.dosePerAdmin||1) * (s.freqPerDay||1);
      totalCalciumMg += fields.calciumMg * units;
      totalPhosphorusMg += fields.phosphorusMg * units;
      totalSodiumMg += fields.sodiumMg * units;
      totalPotassiumMg += (fields.potassiumMg||0) * units;
      totalVitAiu += fields.vitAiu * units;
      totalVitDiu += fields.vitDiu * units;
      totalOmega3Mg += fields.omega3Mg * units;
      totalProteinG += ((fields.proteinMg||0) / 1000) * units; // 보충 단백질/아미노산(mg) → BUN 부하 반영을 위해 g 단위로 합산
    });

    return { foodG, totalProteinG, totalSodiumMg, totalPhosphorusMg, totalCalciumMg, totalVitAiu, totalVitDiu, totalOmega3Mg, totalPotassiumMg, treatG, treatKcal };
  }

  function metaGetEffectiveMedicationEntries(){
    if(metaLoadInput.medicationInputMode === 'infer'){
      const entries = [];
      Object.entries(metaLoadInput.inferredConditions).forEach(([condKey, state])=>{
        if(!state.active) return;
        const map = META_CONDITION_TO_MED_CATEGORY[condKey];
        if(!map) return;
        const sev = map.severities.find(s=>s.id===state.severity) || map.severities[0];
        const category = sev.categoryOverride || map.category;
        entries.push(metaNewMedicationEntry({
          category, agent:'', formulation: state.formulation || 'tablet', knownDoseMg: state.knownDoseMg,
          freqPerDay: state.freqPerDay || 1, dosePerAdmin: state.dosePerAdmin || 1,
          inferred:true, inferredLabel: map.label, organRoute: map.organRoute, severityLabel: sev.label, severityMultiplier: sev.multiplier,
        }));
      });
      return entries;
    }
    return metaLoadInput.medicationEntries;
  }

  function computeOrganBurden(){
    const weight = metaHealthProfile.weight || 5;
    const nutrients = computeMetaNutrientTotals();
    const breed = metaGetEffectiveBreed();
    const referenceMassG = weight * 25;
    const massLoadPct = ((nutrients.foodG + nutrients.treatG) / referenceMassG) * 60;
    const ageFactor = (META_AGE_GROUPS.find(a=>a.id===metaHealthProfile.ageGroup) || META_AGE_GROUPS[1]).capacityFactor;
    const activityFactor = metaGetActivityLevel().burdenFactor; // 저활동=1.10(부하 가산) / 왕성·작업견=0.95~0.90(부하 감산)
    const metabolicRateFactor = ageFactor * activityFactor;

    let liverRaw = massLoadPct * metabolicRateFactor;
    let kidneyRaw = massLoadPct * metabolicRateFactor;
    let liverCapacityReduction = 0;
    let kidneyCapacityReduction = 0;
    const activeOrganConditions = [];

    META_CONDITIONS.forEach(c=>{
      const state = metaHealthProfile.conditions[c.id];
      if(!state || !state.active) return;
      activeOrganConditions.push(c.id);
      const severities = META_CONDITION_SEVERITY[c.id] || [];
      const sev = severities.find(s=>s.id===state.severity) || severities[0] || {};
      if(c.organ === 'kidney'){ kidneyCapacityReduction = Math.max(kidneyCapacityReduction, sev.capacityReduction || 0); kidneyRaw += sev.extraBurden || 0; }
      else if(c.organ === 'liver'){ liverCapacityReduction = Math.max(liverCapacityReduction, sev.capacityReduction || 0); liverRaw += sev.extraBurden || 0; }
      else if(c.organ === 'heart'){ liverRaw += (sev.extraBurden||0) * 0.3; kidneyRaw += sev.extraBurden || 0; }
      else { liverRaw += (sev.extraBurden||0) * 0.2; kidneyRaw += (sev.extraBurden||0) * 0.2; }
    });
    if(metaHealthProfile.bloodwork.kidneyNormal === false) kidneyRaw += 20;
    if(metaHealthProfile.bloodwork.liverNormal === false) liverRaw += 20;

    metaGetEffectiveMedicationEntries().forEach(e=>{
      const w = e.agent ? metaGetAgentWeight(e.category, e.agent) : (ORGAN_LOAD_BY_MED_CATEGORY[e.category] || ORGAN_LOAD_BY_MED_CATEGORY.other);
      const peak = (META_FORMULATION_PEAK_MULTIPLIER[e.formulation] || META_FORMULATION_PEAK_MULTIPLIER.tablet).multiplier;
      const severityMult = e.severityMultiplier || 1.0;
      const doseFactor = metaComputeMedicationDoseFactor(e, weight); // 알 수 그대로, 또는 mg/체중 기반 정밀 보정
      const units = doseFactor * (e.freqPerDay||1);
      // 노령견(Senior)·저활동은 대사·청소율(clearance)이 지연되므로, 약물 부하에도 같은 배율을 곱해요
      // (기존에는 사료/간식 질량 부하에만 적용돼 약물 자체의 대사 지연이 반영되지 않던 부분을 보완했어요).
      liverRaw += w.liver * units * peak * severityMult * metabolicRateFactor;
      kidneyRaw += w.kidney * units * peak * severityMult * metabolicRateFactor;
    });
    Object.values(metaSupplementState).forEach(s=>{
      if(!s.active) return;
      const units = (s.dosePerAdmin||1) * (s.freqPerDay||1);
      liverRaw += 4 * units; kidneyRaw += 4 * units;
    });

    liverRaw *= breed.liverSensitivity;
    kidneyRaw *= breed.kidneySensitivity;

    let liverPct = liverRaw / Math.max(0.15, 1 - liverCapacityReduction);
    let kidneyPct = kidneyRaw / Math.max(0.15, 1 - kidneyCapacityReduction);

    // 복수 기저질환 복합 가중치(Combination Factor) — 특정 조합이 동시에 활성화된 경우 상호 증폭해요.
    const activeCombos = [];
    META_MULTIMORBIDITY_COMBOS.forEach(combo=>{
      if(combo.pair.every(o=>activeOrganConditions.includes(o))){
        liverPct *= combo.liverMult;
        kidneyPct *= combo.kidneyMult;
        activeCombos.push(combo);
      }
    });

    // 장기 손상 상호작용(Synergy Stress) — 이미 존재하는 기저질환(신장/간) 상태에서, 그 장기에
    // 부담을 주는 약물계열(NSAIDs/이뇨제/스테로이드 등)이 들어가면 단순 합산을 넘어 상호 증폭돼요.
    const effectiveMeds = metaGetEffectiveMedicationEntries();
    const activeSynergies = [];
    META_CONDITION_MED_SYNERGY.forEach(syn=>{
      const conditionActive = activeOrganConditions.includes(syn.conditionOrgan);
      const medMatches = effectiveMeds.some(e=>syn.medCategories.includes(e.category));
      if(conditionActive && medMatches){
        liverPct *= syn.liverMult;
        kidneyPct *= syn.kidneyMult;
        activeSynergies.push(syn);
      }
    });

    return {
      liverPct: Math.round(Math.min(500, Math.max(0, liverPct))),
      kidneyPct: Math.round(Math.min(500, Math.max(0, kidneyPct))),
      nutrients, ageFactor, activityFactor, breed, activeCombos, activeSynergies,
    };
  }

  const DNI_MOLECULE_RULES = [
    { molecule:"Enrofloxacin", nutrient:"🦴 칼슘/킬레이트 칼슘", type:"CONFLICT", isolationHours:2,
      note:"퀴놀론계 항생제는 칼슘과 킬레이트를 형성해 항생제 흡수율이 크게 저하될 수 있어요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
    { molecule:"Enrofloxacin", nutrient:"프로바이오틱스(유산균)", type:"CONFLICT", isolationHours:3,
      note:"광범위 항생제가 유익균까지 함께 사멸시켜 프로바이오틱스 효과가 크게 떨어져요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
    { molecule:"Amoxicillin", nutrient:"프로바이오틱스(유산균)", type:"CONFLICT", isolationHours:2,
      note:"항생제 복용 중 유산균은 사멸 위험이 있어 반드시 시간차를 두고 급여해야 해요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
    { molecule:"Furosemide", nutrient:"🦴 칼슘/킬레이트 칼슘", type:"DEPLETION", isolationHours:2,
      note:"루프이뇨제는 칼슘·칼륨·마그네슘 배출을 촉진해 미네랄 고갈 위험이 있어요.",
      reference:"Plumb's Veterinary Drug Handbook; ACVIM Consensus Statement" },
    { molecule:"Furosemide", nutrient:"글루코사민", type:"DEPLETION", isolationHours:2,
      note:"이뇨제로 인한 전해질 손실은 관절 영양제의 미네랄 흡수 효율에도 영향을 줄 수 있어요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
    { molecule:"Prednisolone", nutrient:"🦴 칼슘/킬레이트 칼슘", type:"DEPLETION", isolationHours:2,
      note:"코르티코스테로이드 장기 복용은 칼슘 흡수·대사를 저해할 수 있어요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
    { molecule:"Prednisolone", nutrient:"☀️ 비타민D3/활성 비타민D", type:"DEPLETION", isolationHours:2,
      note:"스테로이드는 비타민D 대사 효소를 억제해 결핍 위험을 높일 수 있어요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
    { molecule:"Carprofen", nutrient:"오메가3(EPA/DHA)", type:"CONFLICT", isolationHours:1,
      note:"NSAIDs와 고용량 오메가3를 동시 급여하면 위장관 출혈 위험이 중복될 수 있어요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
    { molecule:"Meloxicam", nutrient:"오메가3(EPA/DHA)", type:"CONFLICT", isolationHours:1,
      note:"NSAIDs와 고용량 오메가3를 동시 급여하면 위장관 출혈 위험이 중복될 수 있어요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
    { molecule:"Omeprazole", nutrient:"🦴 칼슘/킬레이트 칼슘", type:"CONFLICT", isolationHours:2,
      note:"위산 분비를 억제하는 PPI 계열은 칼슘 흡수에 필요한 위산 환경을 저해할 수 있어요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
    { molecule:"Phenobarbital", nutrient:"☀️ 비타민D3/활성 비타민D", type:"DEPLETION", isolationHours:2,
      note:"항경련제 장기 복용은 간 대사 효소를 유도해 비타민D 대사를 촉진, 결핍 위험을 높일 수 있어요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
    // ---- 신규: 종합영양제/미네랄 핵심 6성분 × 임상 상극 처방약 규칙 ----
    { molecule:"Warfarin", nutrient:"🩸 비타민K", type:"CONFLICT", isolationHours:2,
      note:"⚠️ 약효 상쇄 주의: 비타민K는 와파린 등 항응고제의 혈액응고 억제 작용을 직접 상쇄시켜 약효를 무력화할 수 있어요. 단순 시간차 급여만으로는 완전히 해결되지 않는 상호작용이니, 반드시 수의사와 상담 후 급여 여부를 결정해주세요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed.; ACVIM Consensus Statement" },
    { molecule:"Enrofloxacin", nutrient:"🧲 철분/구리/아연 미네랄", type:"CONFLICT", isolationHours:2,
      note:"철분 등 2가/3가 금속 미네랄은 퀴놀론계 항생제와 킬레이트를 형성해 항생제 흡수율을 크게 낮출 수 있어요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
    { molecule:"Levothyroxine", nutrient:"🧲 철분/구리/아연 미네랄", type:"CONFLICT", isolationHours:4,
      note:"철분/미네랄은 갑상선호르몬제의 위장관 흡수를 크게 저하시켜요. 다른 성분보다 더 넉넉한 간격이 필요해요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
    { molecule:"Enrofloxacin", nutrient:"🧪 마그네슘", type:"CONFLICT", isolationHours:2,
      note:"마그네슘도 칼슘·철분과 마찬가지로 퀴놀론계 항생제와 킬레이트를 형성해 흡수를 저하시킬 수 있어요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
    { molecule:"Benazepril", nutrient:"🧪 마그네슘", type:"CONFLICT", isolationHours:2,
      note:"일부 혈압약(ACE 억제제)과 고용량 마그네슘을 함께 급여하면 흡수·전해질 균형에 영향을 줄 수 있어요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
    { molecule:"Phenobarbital", nutrient:"💡 고용량 비타민B6", type:"CONFLICT", isolationHours:2,
      note:"고용량 피리독신(비타민B6)은 항경련제의 대사를 촉진해 혈중 농도와 발작 조절 효과를 낮출 수 있어요.",
      reference:"Plumb's Veterinary Drug Handbook, 9th ed." },
  ];

  const SEON_DEMO_KEY_PREFIX = 'seon_demo_pk_';

  const SBX_NDC_MAP = {
    enrofloxacin:'NDC 50320-012-10', amoxicillin:'NDC 50320-021-30', cephalexin:'NDC 50320-033-20', metronidazole:'NDC 50320-047-15',
    prednisolone:'NDC 50320-058-10', furosemide:'NDC 50320-064-25', pimobendan:'NDC 50320-072-10', benazepril:'NDC 50320-081-30',
    clopidogrel:'NDC 50320-095-30', warfarin:'NDC 50320-103-10', levothyroxine:'NDC 50320-118-20', meloxicam:'NDC 50320-126-10',
    carprofen:'NDC 50320-137-10', phenobarbital:'NDC 50320-149-10',
  };

  function sbxNorm(s){ return String(s||'').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase(); }

  function sbxAllMolecules(){
    return Object.keys(DRUG_MOLECULES_BY_CATEGORY).flatMap(cat=>DRUG_MOLECULES_BY_CATEGORY[cat].map(name=>({ name, category:cat })));
  }

  function sbxFindMolecule(input){
    const n = sbxNorm(input);
    if(!n) return null;
    const all = sbxAllMolecules();
    return all.find(m=>sbxNorm(m.name)===n) || all.find(m=>{ const mn = sbxNorm(m.name); return mn.includes(n) || n.includes(mn); }) || null;
  }

  function sbxLevenshtein(a,b){
    const m=a.length, n=b.length, d=[];
    for(let i=0;i<=m;i++){ d[i]=[i]; }
    for(let j=1;j<=n;j++){ d[0][j]=j; }
    for(let i=1;i<=m;i++) for(let j=1;j<=n;j++) d[i][j]=Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
    return d[m][n];
  }

  function sbxDidYouMean(input){
    const n = sbxNorm(input);
    let best = null, bestD = 99;
    sbxAllMolecules().forEach(m=>{ const d = sbxLevenshtein(n, sbxNorm(m.name)); if(d < bestD){ bestD = d; best = m.name; } });
    return bestD <= 3 ? best : null;
  }

  function sbxLookupConflict(medName, suppName){
    const mn = sbxNorm(medName), sn = sbxNorm(suppName);
    if(!mn || !sn) return null;
    return DNI_MOLECULE_RULES.find(r=>{
      if(r.type !== 'CONFLICT') return false;
      const rm = sbxNorm(r.molecule), rs = sbxNorm(r.nutrient);
      return (rm.includes(mn) || mn.includes(rm)) && (rs.includes(sn) || sn.includes(rs));
    }) || null;
  }

  function sbxMetaBreedId(label){
    if(label === '토이/미니어처 푸들') return 'poodle_toy';
    const hit = META_BREED_DB.find(b=>b.label === label);
    return hit ? hit.id : 'other';
  }

  function sbxMetaMedCategory(dniCategory){
    return META_MEDICATION_CATEGORIES.some(c=>c.id === dniCategory) ? dniCategory : 'other';
  }

  function sbxSuppToMetaCategory(name){
    const s = String(name||'');
    if(/오메가|EPA|DHA/i.test(s)) return 'omega3';
    if(/유산균|프로바이오/.test(s)) return 'probiotic_standard';
    if(/글루코사민|콘드로|관절/.test(s)) return 'joint';
    if(/콜라겐/.test(s)) return 'collagen';
    if(/신장|방광|크랜베리/.test(s)) return 'kidney_bladder';
    if(/눈|루테인/.test(s)) return 'eye';
    if(/피부/.test(s)) return 'skin';
    return 'multivit_standard';
  }

  function sbxZone(pct, kind){
    if(pct > 100) return 'CRITICAL';
    if(pct > 80) return kind === 'renal' ? 'HIGH_RISK' : 'ELEVATED';
    return 'NORMAL';
  }

  function sbxSnapshotEngineState(){
    const pick = (o, keys)=>{ const s = {}; keys.forEach(k=>{ s[k] = o[k]; }); return s; };
    return {
      dog: pick(dog, ['bcs','conditions','ageYear','breed','plan']),
      hp: pick(metaHealthProfile, ['breed','breedOtherSize','weight','ageGroup','activityLevel']),
      hpConds: Object.assign({}, metaHealthProfile.conditions),
      fi: pick(metaFoodInput, ['dailyG','freqPerDay','treatQuantity']),
      mix: Object.keys(metaFoodInput.mixins).reduce((a,k)=>{ a[k] = metaFoodInput.mixins[k].active; return a; }, {}),
      li: pick(metaLoadInput, ['medicationInputMode']),
      liEntries: metaLoadInput.medicationEntries.slice(),
      liInferred: Object.assign({}, metaLoadInput.inferredConditions),
      ss: Object.keys(metaSupplementState).reduce((a,k)=>{ a[k] = metaSupplementState[k].active; return a; }, {}),
    };
  }

  function sbxRestoreEngineState(sn){
    Object.assign(dog, sn.dog);
    Object.assign(metaHealthProfile, sn.hp);
    Object.keys(metaHealthProfile.conditions).forEach(k=>{ delete metaHealthProfile.conditions[k]; });
    Object.assign(metaHealthProfile.conditions, sn.hpConds);
    Object.assign(metaFoodInput, sn.fi);
    Object.keys(sn.mix).forEach(k=>{ metaFoodInput.mixins[k].active = sn.mix[k]; });
    Object.assign(metaLoadInput, sn.li);
    metaLoadInput.medicationEntries.length = 0;
    sn.liEntries.forEach(e=>metaLoadInput.medicationEntries.push(e));
    Object.keys(metaLoadInput.inferredConditions).forEach(k=>{ delete metaLoadInput.inferredConditions[k]; });
    Object.assign(metaLoadInput.inferredConditions, sn.liInferred);
    Object.keys(sn.ss).forEach(k=>{ metaSupplementState[k].active = sn.ss[k]; });
  }

  function sbxRunEngines(pet, rxList, suppNames){
    const sn = sbxSnapshotEngineState();
    try{
      const conds = Array.isArray(pet.conditions) ? pet.conditions : [];
      // ① 건강 스코어 (실제 computeHealthScore)
      dog.bcs = pet.bcs; dog.conditions = conds.slice(); dog.ageYear = pet.age_years; dog.breed = pet.breed; dog.plan = 'general';
      const health = computeHealthScore({ allocation:{ snackRatio:0.05, supplementRatio:Math.min(0.15, 0.03*suppNames.length) } });
      // ② 간·신장 대사 부하 (실제 computeOrganBurden)
      const w = pet.weight_kg;
      metaHealthProfile.breed = sbxMetaBreedId(pet.breed);
      metaHealthProfile.breedOtherSize = w < 7 ? '소형' : w < 15 ? '중형' : w < 30 ? '대형' : '초대형';
      metaHealthProfile.weight = w;
      metaHealthProfile.ageGroup = pet.age_years < 1 ? 'young' : pet.age_years >= 7 ? 'senior' : 'adult';
      metaHealthProfile.activityLevel = 'normal';
      Object.keys(metaHealthProfile.conditions).forEach(k=>{ delete metaHealthProfile.conditions[k]; });
      conds.forEach(c=>{
        if(!META_CONDITIONS.some(mc=>mc.id === c)) return;
        const sev = META_CONDITION_SEVERITY[c] || [];
        metaHealthProfile.conditions[c] = { active:true, severity:(sev[1] || sev[0] || {}).id };
      });
      const kcalPerG = (metaFoodInput.kcalPerKg || 3650) / 1000;
      metaFoodInput.dailyG = Math.round((1.6 * 70 * Math.pow(w, 0.75)) / kcalPerG);
      metaFoodInput.freqPerDay = 2; metaFoodInput.treatQuantity = 0;
      Object.keys(metaFoodInput.mixins).forEach(k=>{ metaFoodInput.mixins[k].active = false; });
      metaLoadInput.medicationInputMode = 'manual';
      Object.keys(metaLoadInput.inferredConditions).forEach(k=>{ delete metaLoadInput.inferredConditions[k]; });
      metaLoadInput.medicationEntries.length = 0;
      rxList.forEach(r=>metaLoadInput.medicationEntries.push(metaNewMedicationEntry({ category:sbxMetaMedCategory(r.category), freqPerDay:r.frequency_per_day })));
      Object.keys(metaSupplementState).forEach(k=>{ metaSupplementState[k].active = false; });
      suppNames.forEach(name=>{ const c = sbxSuppToMetaCategory(name); if(metaSupplementState[c]) metaSupplementState[c].active = true; });
      const burden = computeOrganBurden();
      return { health, burden };
    } finally {
      sbxRestoreEngineState(sn);
    }
  }

  function sbxRequestId(){ return 'req_sbx_' + Math.random().toString(36).slice(2, 10); }

  function sbxError(http, message, extra){
    return { http, body: Object.assign({ status:'ERROR', code:http, message, request_id:sbxRequestId() }, extra || {}) };
  }

  function sbxProcessRequest(req, view, key){
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if(!key || !String(key).startsWith(SEON_DEMO_KEY_PREFIX)) return sbxError(401, 'Invalid or missing X-SEON-API-KEY', { fallback:'Sandbox 키는 seon_demo_pk_ 로 시작해야 해요. Enterprise PoC 탭에서 발급받을 수 있어요.' });
    if(!req || typeof req !== 'object' || !req.pet || typeof req.pet !== 'object') return sbxError(400, 'Missing required field: pet');
    const w = Number(req.pet.weight_kg);
    if(!(w >= 0.5 && w <= 100)) return sbxError(422, 'pet.weight_kg must be a number between 0.5 and 100');
    const age = req.pet.age_years == null ? 5 : Number(req.pet.age_years);
    if(!(age >= 0 && age <= 30)) return sbxError(422, 'pet.age_years must be a number between 0 and 30');
    const bcsRaw = req.pet.bcs == null ? 5 : Number(req.pet.bcs);
    if(!(bcsRaw >= 1 && bcsRaw <= 9)) return sbxError(422, 'pet.bcs must be a number between 1 and 9');
    const pet = { breed:String(req.pet.breed || '믹스견'), weight_kg:w, age_years:age, bcs:Math.round(bcsRaw), conditions:Array.isArray(req.pet.conditions) ? req.pet.conditions.map(String) : [] };

    const rx = [];
    const suppNames = Array.isArray(req.supplements) ? req.supplements.map(String).filter(Boolean) : [];
    if(view === 'full'){
      const list = Array.isArray(req.prescriptions) ? req.prescriptions : [];
      for(const item of list){
        const rawName = typeof item === 'string' ? item : (item && item.name);
        const freq = Math.max(1, Math.min(4, parseInt(item && item.frequency_per_day) || 1));
        const found = sbxFindMolecule(rawName);
        if(!found) return sbxError(422, `Unknown molecule name: '${rawName}'`, { did_you_mean: sbxDidYouMean(rawName), fallback:'성분명을 인식하지 못하면 일반 주의 문구로 안전하게 폴백돼요.' });
        rx.push({ name:found.name, category:found.category, frequency_per_day:freq, ndc_code: SBX_NDC_MAP[found.name.toLowerCase().split(' ')[0]] || null });
      }
    }
    let engines;
    try{ engines = sbxRunEngines(pet, rx, view === 'full' ? suppNames : []); }
    catch(e){ return sbxError(500, 'Engine error: ' + (e && e.message ? e.message : e)); }
    const { health, burden } = engines;
    const latency = Math.max(1, Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0));
    const meta = { mode:'sandbox', engine:'seon-engine (computeHealthScore · computeOrganBurden · DNI rules)', ndc_mapping:'sandbox-illustrative (production maps to a licensed NDC directory)' };

    if(view === 'health'){
      return { http:200, body:{
        status:'SUCCESS', request_id:sbxRequestId(), latency_ms:latency,
        health_score:health.score, health_light:health.light, verdict:health.verdict,
        inputs:{ breed:pet.breed, age_years:pet.age_years, bcs:pet.bcs, conditions_count:pet.conditions.length },
        fhir_compatible:true, meta,
      }};
    }
    const conflicts = [];
    rx.forEach(r=>suppNames.forEach(s=>{
      const rule = sbxLookupConflict(r.name, s);
      if(rule) conflicts.push({ pair:`${r.name} x ${s}`, medication:r.name, supplement:s, isolation_hours:rule.isolationHours, mechanism:rule.note, reference:rule.reference });
    }));
    const isolationHours = conflicts.reduce((m,c)=>Math.max(m, c.isolation_hours), 0);
    const hepatic = burden.liverPct, renal = burden.kidneyPct;
    const first = conflicts[0];
    const schedule = first
      ? `08:00 ${first.medication} | ${String(8 + first.isolation_hours).padStart(2,'0')}:00 ${first.supplement}`
      : (rx.length ? '제약 없음 — 평소 급여 스케줄을 유지하세요.' : '처방약 미입력 — 스케줄 산출 대상 없음');
    return { http:200, body:{
      status:'SUCCESS', request_id:sbxRequestId(), latency_ms:latency,
      ndc_code: rx.length ? rx[0].ndc_code : null,
      health_score:health.score,
      hepatic_strain_index:hepatic,
      renal_clearance_burden:renal,
      isolation_hours:isolationHours,
      fhir_compatible:true,
      health_light:health.light,
      organ_strain_zones:{ hepatic:sbxZone(hepatic,'hepatic'), renal:sbxZone(renal,'renal') },
      dni_conflict_detected:conflicts.length > 0,
      conflicts,
      recommended_schedule:schedule,
      prescriptions:rx.map(r=>({ name:r.name, ndc_code:r.ndc_code, category:r.category, frequency_per_day:r.frequency_per_day })),
      meta,
    }};
  }
  return { sbxProcessRequest, SEON_DEMO_KEY_PREFIX };
})();
/* ================= /SEON ENGINE ================= */

/* ---------------- 설정 ---------------- */
const PORT = parseInt(process.env.PORT, 10) || 3000;
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MIN, 10) || 60;
const BODY_LIMIT = process.env.BODY_LIMIT || '100kb';
const ALLOW_DEMO_KEYS = String(process.env.ALLOW_DEMO_KEYS || 'true').toLowerCase() !== 'false';
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);
const MAX_PRESCRIPTIONS = 20;
const MAX_SUPPLEMENTS = 30;
const sha = v => crypto.createHash('sha256').update(String(v)).digest();
const PROD_KEY_HASHES = (process.env.SEON_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean).map(sha);
const ENGINE_INTERNAL_KEY = ENGINE.SEON_DEMO_KEY_PREFIX + 'server'; // 엔진 내부 검증용 (인증은 아래 미들웨어에서 수행)

const NOTICE = 'Non-diagnostic clinical decision-support signal (FDA/CVM aligned). Final diagnosis and prescribing decisions belong to a licensed veterinarian.';

/* ---------------- 유틸 ---------------- */
const reqId = () => 'req_srv_' + crypto.randomBytes(5).toString('hex');
function sendError(res, http, message, extra){
  const id = reqId();
  res.set('X-SEON-Request-Id', id);
  return res.status(http).json(Object.assign({ status: 'ERROR', code: http, message, request_id: id }, extra || {}));
}
function isValidKey(key){
  if(!key || typeof key !== 'string') return false;
  if(ALLOW_DEMO_KEYS && key.startsWith(ENGINE.SEON_DEMO_KEY_PREFIX) && key.length > ENGINE.SEON_DEMO_KEY_PREFIX.length) return true;
  const h = sha(key);
  return PROD_KEY_HASHES.some(p => crypto.timingSafeEqual(p, h)); // 타이밍 공격 방지
}

/* ---------------- 앱 ---------------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(cors({
  origin: CORS_ORIGINS.includes('*') ? '*' : CORS_ORIGINS,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-SEON-API-KEY'],
  exposedHeaders: ['X-SEON-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
  maxAge: 86400,
}));
app.use(express.json({ limit: BODY_LIMIT }));

/* ---------------- 인증 + Rate Limit (/v1/*) ---------------- */
const windows = new Map(); // key -> { count, reset }
setInterval(() => { const now = Date.now(); for(const [k, w] of windows) if(now >= w.reset) windows.delete(k); }, 60000).unref();

function authenticate(req, res, next){
  const key = req.get('X-SEON-API-KEY');
  if(!isValidKey(key)){
    return sendError(res, 401, 'Invalid or missing X-SEON-API-KEY', {
      fallback: '키를 재확인하고, 위젯은 경고 없이 기본 화면으로 폴백하세요.',
    });
  }
  const now = Date.now();
  let w = windows.get(key);
  if(!w || now >= w.reset){ w = { count: 0, reset: now + 60000 }; windows.set(key, w); }
  w.count++;
  res.set('X-RateLimit-Limit', String(RATE_LIMIT));
  res.set('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT - w.count)));
  if(w.count > RATE_LIMIT){
    res.set('Retry-After', String(Math.max(1, Math.ceil((w.reset - now) / 1000))));
    return sendError(res, 429, `Rate limit exceeded (${RATE_LIMIT} req/min)`, {
      fallback: '직전 응답을 캐싱해 위젯이 끊기지 않고 유지되도록 하세요.',
    });
  }
  next();
}

/* ---------------- Routes ---------------- */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'seon-api-server', uptime_s: Math.round(process.uptime()) });
});

app.post('/v1/analyze', authenticate, (req, res) => {
  if(!req.is('application/json')) return sendError(res, 415, 'Content-Type must be application/json');
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // pet_bio 가 표준 필드명이에요. Live API Sandbox가 쓰는 'pet' 도 별칭으로 받아요.
  const usedLegacyName = body.pet_bio === undefined && body.pet !== undefined;
  const fieldName = usedLegacyName ? 'pet' : 'pet_bio';
  const petBio = usedLegacyName ? body.pet : body.pet_bio;

  if(petBio == null || typeof petBio !== 'object' || Array.isArray(petBio)){
    return sendError(res, 400, 'Missing required field: pet_bio', {
      fallback: "필수 파라미터 누락 시 위젯은 '데이터 부족' 상태로 표시돼요.",
    });
  }
  for(const f of ['prescriptions', 'supplements']){
    if(body[f] !== undefined && !Array.isArray(body[f])) return sendError(res, 400, `${f} must be an array`);
  }
  const prescriptions = body.prescriptions || [];
  const supplements = body.supplements || [];
  if(prescriptions.length > MAX_PRESCRIPTIONS) return sendError(res, 422, `prescriptions supports up to ${MAX_PRESCRIPTIONS} items`);
  if(supplements.length > MAX_SUPPLEMENTS) return sendError(res, 422, `supplements supports up to ${MAX_SUPPLEMENTS} items`);

  let result;
  try{
    result = ENGINE.sbxProcessRequest({ pet: petBio, prescriptions, supplements }, 'full', ENGINE_INTERNAL_KEY);
  }catch(e){
    console.error('[seon] engine failure:', e);
    return sendError(res, 500, 'Internal engine error', { fallback: '일시적 오류예요. 잠시 후 재시도하거나 직전 응답을 유지하세요.' });
  }

  res.set('Cache-Control', 'no-store');
  const out = result.body;
  res.set('X-SEON-Request-Id', out.request_id);
  if(result.http !== 200){
    if(typeof out.message === 'string') out.message = out.message.replace(/\bpet\./g, fieldName + '.');
    return res.status(result.http).json(out);
  }
  out.meta = Object.assign({}, out.meta, { served_by: 'seon-api-server', notice: NOTICE });
  res.status(200).json(out);
});

app.all('/v1/analyze', (req, res) => { res.set('Allow', 'POST, OPTIONS'); sendError(res, 405, 'Method not allowed. Use POST /v1/analyze'); });
app.use((req, res) => sendError(res, 404, `Route not found: ${req.method} ${req.path}`));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if(err && err.type === 'entity.parse.failed') return sendError(res, 400, 'Malformed JSON body');
  if(err && err.type === 'entity.too.large') return sendError(res, 413, `Request body too large (limit ${BODY_LIMIT})`);
  console.error('[seon] unhandled error:', err);
  sendError(res, 500, 'Internal server error');
});

if(require.main === module){
  const server = app.listen(PORT, () => {
    console.log(`[seon] API server listening on :${PORT}  (POST /v1/analyze · GET /health)`);
    console.log(`[seon] CORS: ${CORS_ORIGINS.join(', ')} | demo keys: ${ALLOW_DEMO_KEYS ? 'allowed' : 'blocked'} | prod keys: ${PROD_KEY_HASHES.length} | limit: ${RATE_LIMIT}/min`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = app;
