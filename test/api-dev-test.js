const assert = require('assert');
const { fetchRealLegalDocument, cleanLegalDocumentContent } = require('../server.js');

(async () => {
  console.log('Running eLegal Real Document Extraction Test Suite...\n');

  // Test 1: Mugo v Kimathi (DOCX export on Kenya Law Akoma Ntoso)
  console.log('Test 1: Testing Mugo v Kimathi [2026] KEELC 1201 (DOCX extraction)...');
  const mugoDoc = await fetchRealLegalDocument('https://kenyalaw.org/akn/ke/judgment/keelc/2026/1201/eng@2026-02-25');
  assert(mugoDoc, 'Should successfully extract Mugo v Kimathi document');
  assert(mugoDoc.text.includes('CHRISTOPHER KARIUKI MUGO'), 'Text should contain plaintiff name');
  assert(mugoDoc.text.includes('FIDIS IGOKI KIMATHI'), 'Text should contain defendant name');
  assert(!mugoDoc.text.includes('Loading PDF...'), 'Text should not contain PDF viewer placeholder');
  assert(!mugoDoc.text.includes('Official Statutory Record'), 'Text should not contain synthetic placeholder');
  console.log('  ✅ Passed: Mugo v Kimathi extracted ' + mugoDoc.text.length + ' chars of verbatim judgment.\n');

  // Test 2: Mtana Lewa v Kahindi Ngala (Akoma Ntoso HTML judgment)
  console.log('Test 2: Testing Mtana Lewa v Kahindi Ngala [2016] KECA 544 (AKN HTML extraction)...');
  const mtanaDoc = await fetchRealLegalDocument('https://kenyalaw.org/akn/ke/judgment/keca/2016/544/eng@2016-05-27');
  assert(mtanaDoc, 'Should successfully extract Mtana Lewa document');
  assert(mtanaDoc.text.includes('MTANA LEWA'), 'Text should contain applicant name');
  assert(mtanaDoc.text.includes('KAHINDI NGALA MWAGANDI'), 'Text should contain respondent name');
  assert(!mtanaDoc.text.includes('Official Statutory Record'), 'Text should not contain synthetic placeholder');
  console.log('  ✅ Passed: Mtana Lewa extracted ' + mtanaDoc.text.length + ' chars of verbatim judgment.\n');

  // Test 3: Limitation of Actions Act (Statute text extraction)
  console.log('Test 3: Testing Limitation of Actions Act CAP. 22 (Statute extraction)...');
  const actDoc = await fetchRealLegalDocument('https://kenyalaw.org/akn/ke/act/1968/21/eng@2022-12-31');
  assert(actDoc, 'Should successfully extract Limitation of Actions Act');
  assert(actDoc.text.includes('LIMITATION OF ACTIONS ACT') || actDoc.text.includes('LAWS OF KENYA'), 'Text should contain statute title');
  assert(!actDoc.text.includes('Official Statutory Record | Limitation Act'), 'Text should not contain synthetic placeholder');
  console.log('  ✅ Passed: Limitation of Actions Act extracted ' + actDoc.text.length + ' chars of statutory text.\n');

  console.log('🎉 ALL TESTS PASSED! 100% real document extraction verified with zero pseudo pages.');
})();
