import { expect, it } from 'bun:test';
import { compareVerificationVersions } from './unity-verification-versions';
it('selects the latest numeric 6.3 LTS patch before newer releases and betas', () => {
  expect(['6000.7.0b1','6000.6.2f1','6000.0.84f1','6000.3.5f2','6000.3.24f1','2022.3.62f1'].sort(compareVerificationVersions))
    .toEqual(['6000.3.24f1','6000.3.5f2','6000.0.84f1','2022.3.62f1','6000.6.2f1','6000.7.0b1']);
});
