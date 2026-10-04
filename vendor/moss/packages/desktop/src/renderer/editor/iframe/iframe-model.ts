// ported-from: packages/desktop/src/renderer/editor/iframe/iframe-model.ts @ 762abb777
/**
 * Renderer-side iframe model. Wraps the shared, React-free
 * `embed-iframe-policy` in source/title data that `IframeFrame` turns into an
 * actual `<iframe>`. Node components build a model via these helpers instead of
 * hard-coding sandbox/allow/referrer attributes.
 */
import type React from 'react';

import {
  getEmbedIframePolicy,
  type EmbedIframeRiskProfile
} from '../../../common/embed-iframe-policy';

export type IframeSource =
  | { kind: 'srcDoc'; srcDoc: string }
  | { kind: 'remote'; src: string };

export interface IframeModel {
  source: IframeSource;
  title: string;
  riskProfile: EmbedIframeRiskProfile;
  sandbox: string;
  referrerPolicy?: React.HTMLAttributeReferrerPolicy;
  loading?: 'lazy' | 'eager';
  allow?: string;
  allowFullScreen?: boolean;
}

const buildIframeModel = (
  riskProfile: EmbedIframeRiskProfile,
  source: IframeSource,
  title: string
): IframeModel => {
  const policy = getEmbedIframePolicy(riskProfile);
  return {
    source,
    title,
    riskProfile,
    sandbox: policy.sandbox,
    referrerPolicy: policy.referrerPolicy,
    loading: policy.loading,
    allow: policy.allow,
    allowFullScreen: policy.allowFullScreen
  };
};

export function createLocalHtmlPreviewIframeModel(input: {
  srcDoc: string;
  title: string;
}): IframeModel {
  return buildIframeModel(
    'local-html-preview',
    { kind: 'srcDoc', srcDoc: input.srcDoc },
    input.title
  );
}

export function createRemoteOEmbedPreviewIframeModel(input: {
  srcDoc: string;
  title: string;
}): IframeModel {
  return buildIframeModel(
    'remote-oembed-preview',
    { kind: 'srcDoc', srcDoc: input.srcDoc },
    input.title
  );
}

export function createRemoteSocialEmbedIframeModel(input: {
  src: string;
  title: string;
}): IframeModel {
  return buildIframeModel(
    'remote-social-embed',
    { kind: 'remote', src: input.src },
    input.title
  );
}

export function createRemoteVideoIframeModel(input: {
  src: string;
  title: string;
}): IframeModel {
  return buildIframeModel('remote-video', { kind: 'remote', src: input.src }, input.title);
}

export function createRemoteWebpageIframeModel(input: {
  src: string;
  title: string;
}): IframeModel {
  return buildIframeModel('remote-webpage', { kind: 'remote', src: input.src }, input.title);
}
