import type { CognitoConfig } from '../auth/authService.ts';

/** Public AWS resource identifiers produced by the PhotoArchive CDK deployment. */
export const PHOTO_ARCHIVE_AWS = {
  region: 'ap-southeast-2',
  bucket: 'photoarchivestorage-photoarchivebucket03259f1b-pi91iiuhii6r',
  userPoolId: 'ap-southeast-2_ZRd1rEqNC',
  userPoolClientId: '5p87d5r4ojifi4p511nqehk4bg',
  identityPoolId: 'ap-southeast-2:cf6ce817-288a-4a26-b39c-f29735691fe3',
  userPoolDomain: 'photo-archive-860100076027.auth.ap-southeast-2.amazoncognito.com',
  syncFunctionUrl: 'https://t3s3r7wsbveajzxfs2jtfqypg40zaqfq.lambda-url.ap-southeast-2.on.aws/',
} as const;

export const cognitoConfig: CognitoConfig = {
  domain: PHOTO_ARCHIVE_AWS.userPoolDomain,
  clientId: PHOTO_ARCHIVE_AWS.userPoolClientId,
  region: PHOTO_ARCHIVE_AWS.region,
};
