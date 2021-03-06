import {
  OnboardingActions,
  CHANGE_PAGE,
  ScreenName,
  DEFAULT_PASSWORD,
  SAVE_KEY,
  SAVE_AUTH_REQUEST,
  SET_MAGIC_RECOVERY_CODE,
  SET_USERNAME,
} from './types';
import { decodeToken } from 'jsontokens';
import { doGenerateWallet, didGenerateWallet, WalletActions } from '../wallet';
import { ThunkAction } from 'redux-thunk';
import { decrypt } from '@blockstack/keychain';
import { DecodedAuthRequest, AppManifest } from '../../common/dev/types';
import { AppState } from '@store';
import {
  selectDecodedAuthRequest,
  selectAuthRequest,
  selectAppIcon,
  selectAppName,
  selectCurrentScreen,
} from './selectors';
import { selectIdentities, selectCurrentWallet } from '@store/wallet/selectors';
import { finalizeAuthResponse } from '@common/utils';
import { gaiaUrl } from '@common/constants';
import { doTrackScreenChange } from '@common/track';

export const doChangeScreen = (screen: ScreenName): OnboardingActions => {
  return {
    type: CHANGE_PAGE,
    screen,
  };
};

export const doSaveSecretKey = (secretKey: string): OnboardingActions => ({
  type: SAVE_KEY,
  secretKey,
});

export const doSetMagicRecoveryCode = (magicRecoveryCode: string): OnboardingActions => ({
  type: SET_MAGIC_RECOVERY_CODE,
  magicRecoveryCode,
});

export const doSetUsername = (username: string): OnboardingActions => ({
  type: SET_USERNAME,
  username,
});

export function doCreateSecretKey(): ThunkAction<void, AppState, {}, OnboardingActions | WalletActions> {
  return async dispatch => {
    const wallet = await dispatch(doGenerateWallet(DEFAULT_PASSWORD));
    const secretKey = await decrypt(wallet.encryptedBackupPhrase, DEFAULT_PASSWORD);
    dispatch(didGenerateWallet(wallet));
    dispatch(doSaveSecretKey(secretKey));
  };
}

const loadManifest = async (decodedAuthRequest: DecodedAuthRequest) => {
  const res = await fetch(decodedAuthRequest.manifest_uri);
  const json: AppManifest = await res.json();
  return json;
};

interface SaveAuthRequestParams {
  appName: string;
  appIcon: string;
  decodedAuthRequest: DecodedAuthRequest;
  authRequest: string;
  appURL: URL;
}

const saveAuthRequest = ({
  appName,
  appIcon,
  decodedAuthRequest,
  authRequest,
  appURL,
}: SaveAuthRequestParams): OnboardingActions => {
  return {
    type: SAVE_AUTH_REQUEST,
    appName,
    appIcon,
    decodedAuthRequest,
    authRequest,
    appURL,
  };
};

export function doSaveAuthRequest(authRequest: string): ThunkAction<void, AppState, {}, OnboardingActions> {
  return async (dispatch, getState) => {
    const { payload } = decodeToken(authRequest);
    const decodedAuthRequest = (payload as unknown) as DecodedAuthRequest;
    let appName = decodedAuthRequest.appDetails?.name;
    let appIcon = decodedAuthRequest.appDetails?.icon;
    if (!appName || !appIcon) {
      const appManifest = await loadManifest(decodedAuthRequest);
      appName = appManifest.name;
      appIcon = appManifest.icons[0].src as string;
    }
    dispatch(
      saveAuthRequest({
        decodedAuthRequest,
        authRequest,
        appName,
        appIcon,
        appURL: new URL(decodedAuthRequest.redirect_uri),
      })
    );
    const state = getState();
    const screen = selectCurrentScreen(state);
    const identities = selectIdentities(state);
    const hasIdentities = identities && identities.length;
    if ((screen === ScreenName.GENERATION || screen === ScreenName.SIGN_IN) && hasIdentities) {
      doTrackScreenChange(ScreenName.CHOOSE_ACCOUNT, decodedAuthRequest);
      dispatch(doChangeScreen(ScreenName.CHOOSE_ACCOUNT));
    } else {
      doTrackScreenChange(screen, decodedAuthRequest);
    }
  };
}

export function doFinishSignIn(
  { identityIndex }: { identityIndex: number } = { identityIndex: 0 }
): ThunkAction<Promise<void>, AppState, {}, OnboardingActions | WalletActions> {
  return async (dispatch, getState) => {
    const state = getState();
    const identities = selectIdentities(state);
    const decodedAuthRequest = selectDecodedAuthRequest(state);
    const authRequest = selectAuthRequest(state);
    const wallet = selectCurrentWallet(state);
    const appIcon = selectAppIcon(state);
    const appName = selectAppName(state);
    if (!decodedAuthRequest || !authRequest || !identities || !wallet) {
      console.error('Uh oh! Finished onboarding without auth info.');
      return;
    }
    const appURL = new URL(decodedAuthRequest.redirect_uri);
    const currentIdentity = identities[identityIndex];
    await currentIdentity.refresh();
    const gaiaConfig = await wallet.createGaiaConfig(gaiaUrl);
    await wallet.getOrCreateConfig(gaiaConfig);
    await wallet.updateConfigWithAuth({
      identityIndex,
      gaiaConfig,
      app: {
        origin: appURL.origin,
        lastLoginAt: new Date().getTime(),
        scopes: decodedAuthRequest.scopes,
        appIcon: appIcon as string,
        name: appName as string,
      },
    });
    const authResponse = await currentIdentity.makeAuthResponse({
      gaiaUrl,
      appDomain: appURL.origin,
      transitPublicKey: decodedAuthRequest.public_keys[0],
    });
    finalizeAuthResponse({ decodedAuthRequest, authRequest, authResponse });
    dispatch(didGenerateWallet(wallet));
  };
}
