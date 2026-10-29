import { createContext, useContext } from 'react';
/** True when the app is the signed-in hosted version (files and records live on the server, privately per student) rather than the local single-user app. */
export const HostedContext = createContext(false);
export const useHosted = () => useContext(HostedContext);
