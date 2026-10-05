// Pure node seams are also loaded by the headless converter.
export {
  readRegister, writeRegister, writeRegisterEdit, readMapRegister, writeMapRegister, initRegisterNode, registerState, $assignRegisterIds,
  registerDoc, bindRegisters, REGISTER_LOCAL_ORIGIN, RegisterDraft,
} from '@moss-multi/sync/registers';
export { diffText } from '@moss-multi/core/text-diff';
