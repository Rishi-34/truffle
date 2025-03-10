import debugModule from "debug";
const debug = debugModule("decoder:decoders");

import * as Abi from "@truffle/abi-utils";
import * as Codec from "@truffle/codec";
import {
  AbiData,
  Ast,
  Evm,
  Format,
  Conversion,
  Storage,
  Contexts,
  Compilations,
  Compiler,
  CalldataDecoding,
  LogDecoding,
  ReturndataDecoding,
  decodeCalldata,
  decodeEvent,
  decodeReturndata
} from "@truffle/codec";
import * as Utils from "./utils";
import type * as DecoderTypes from "./types";
import Web3Utils from "web3-utils";
import type { ContractObject as Artifact } from "@truffle/contract-schema/spec";
import BN from "bn.js";
import type { Provider } from "web3/providers";
import {
  ContractBeingDecodedHasNoNodeError,
  ContractAllocationFailedError,
  ContractNotFoundError,
  InvalidAddressError,
  VariableNotFoundError,
  MemberNotFoundError,
  NoProviderError
} from "./errors";
import { Shims } from "@truffle/compile-common";
import { ProviderAdapter } from "./ProviderAdapter";
//sorry for the untyped import, but...
const SourceMapUtils = require("@truffle/source-map-utils");

/**
 * The ProjectDecoder class.  Decodes transactions and logs.  See below for a method listing.
 * @category Decoder
 */
export class ProjectDecoder {
  private providerAdapter: ProviderAdapter;

  private compilations: Compilations.Compilation[];
  private contexts: Contexts.Contexts = {}; //all contexts
  private deployedContexts: Contexts.Contexts = {};
  private contractsAndContexts: AbiData.Allocate.ContractAndContexts[] = [];

  private referenceDeclarations: { [compilationId: string]: Ast.AstNodes };
  private userDefinedTypesByCompilation: Format.Types.TypesByCompilationAndId;
  private userDefinedTypes: Format.Types.TypesById;
  private allocations: Evm.AllocationInfo;

  private codeCache: DecoderTypes.CodeCache = {};

  private ensSettings: DecoderTypes.EnsSettings;

  /**
   * @protected
   */
  constructor(
    compilations: Compilations.Compilation[],
    provider: Provider,
    ensSettings?: DecoderTypes.EnsSettings
  ) {
    if (!provider) {
      throw new NoProviderError();
    }
    this.providerAdapter = new ProviderAdapter(provider);
    this.compilations = compilations;
    this.ensSettings = ensSettings || {};
    let allocationInfo: AbiData.Allocate.ContractAllocationInfo[];

    ({
      definitions: this.referenceDeclarations,
      typesByCompilation: this.userDefinedTypesByCompilation,
      types: this.userDefinedTypes
    } = Compilations.Utils.collectUserDefinedTypesAndTaggedOutputs(
      this.compilations
    ));

    ({
      contexts: this.contexts,
      deployedContexts: this.deployedContexts,
      contractsAndContexts: this.contractsAndContexts,
      allocationInfo
    } = AbiData.Allocate.Utils.collectAllocationInfo(this.compilations));

    this.allocations = {};
    this.allocations.abi = AbiData.Allocate.getAbiAllocations(
      this.userDefinedTypes
    );
    this.allocations.storage = Storage.Allocate.getStorageAllocations(
      this.userDefinedTypesByCompilation
    ); //not used by project decoder itself, but used by contract decoder
    this.allocations.calldata = AbiData.Allocate.getCalldataAllocations(
      allocationInfo,
      this.referenceDeclarations,
      this.userDefinedTypes,
      this.allocations.abi
    );
    this.allocations.returndata = AbiData.Allocate.getReturndataAllocations(
      allocationInfo,
      this.referenceDeclarations,
      this.userDefinedTypes,
      this.allocations.abi
    );
    this.allocations.event = AbiData.Allocate.getEventAllocations(
      allocationInfo,
      this.referenceDeclarations,
      this.userDefinedTypes,
      this.allocations.abi
    );
    this.allocations.state = Storage.Allocate.getStateAllocations(
      allocationInfo,
      this.referenceDeclarations,
      this.userDefinedTypes,
      this.allocations.storage
    );
    debug("done with allocation");
  }

  /**
   * @protected
   */
  public async getCode(
    address: string,
    block: DecoderTypes.RegularizedBlockSpecifier
  ): Promise<Uint8Array> {
    //if pending, ignore the cache
    if (block === "pending") {
      return Conversion.toBytes(
        await this.providerAdapter.getCode(address, block)
      );
    }

    //otherwise, start by setting up any preliminary layers as needed
    if (this.codeCache[block] === undefined) {
      this.codeCache[block] = {};
    }
    //now, if we have it cached, just return it
    if (this.codeCache[block][address] !== undefined) {
      return this.codeCache[block][address];
    }
    //otherwise, get it, cache it, and return it
    let code = Conversion.toBytes(
      await this.providerAdapter.getCode(address, block)
    );
    this.codeCache[block][address] = code;
    return code;
  }

  /**
   * @protected
   */
  public async regularizeBlock(
    block: DecoderTypes.BlockSpecifier | null
  ): Promise<DecoderTypes.RegularizedBlockSpecifier> {
    if (typeof block === "number" || block === "pending") {
      return block;
    }
    if (block === null) {
      return "pending";
    }

    return (await this.providerAdapter.getBlockByNumber(block)).number;
  }

  /**
   * **This method is asynchronous.**
   *
   * Takes a [[Transaction]] object and decodes it.  The result is a
   * [[CalldataDecoding]]; see the documentation on that interface for more.
   *
   * Note that decoding of transactions sent to libraries is presently not
   * supported and may have unreliable results.  Limited support for this is
   * planned for future versions.
   * @param transaction The transaction to be decoded.
   */
  public async decodeTransaction(
    transaction: DecoderTypes.Transaction
  ): Promise<CalldataDecoding> {
    return await this.decodeTransactionWithAdditionalContexts(transaction);
  }

  /**
   * @protected
   */
  public async decodeTransactionWithAdditionalContexts(
    transaction: DecoderTypes.Transaction,
    additionalContexts: Contexts.Contexts = {}
  ): Promise<CalldataDecoding> {
    const block = transaction.blockNumber;
    const blockNumber = await this.regularizeBlock(block);
    const isConstructor = transaction.to === null;
    const context = await this.getContextByAddress(
      transaction.to,
      blockNumber,
      transaction.input,
      additionalContexts
    );

    const data = Conversion.toBytes(transaction.input);
    const info: Evm.EvmInfo = {
      state: {
        storage: {},
        calldata: data
      },
      userDefinedTypes: this.userDefinedTypes,
      allocations: this.allocations,
      contexts: { ...this.deployedContexts, ...additionalContexts },
      currentContext: context
    };
    const decoder = decodeCalldata(info, isConstructor);

    let result = decoder.next();
    while (result.done === false) {
      let request = result.value;
      let response: Uint8Array;
      switch (request.type) {
        case "code":
          response = await this.getCode(request.address, blockNumber);
          break;
        //not writing a storage case as it shouldn't occur here!
      }
      result = decoder.next(response);
    }
    //at this point, result.value holds the final value
    return result.value;
  }

  /**
   * **This method is asynchronous.**
   *
   * Takes a [[Log]] object and decodes it.  Logs can be ambiguous, so this so
   * this function returns an array of [[LogDecoding|LogDecodings]].
   *
   * Note that logs are decoded in strict mode, so (with one exception) none of the decodings should
   * contain errors; if a decoding would contain an error, instead it is simply excluded from the
   * list of possible decodings.  The one exception to this is that indexed parameters of reference
   * type cannot meaningfully be decoded, so those will decode to an error.
   *
   * If there are multiple possible decodings, they will always be listed in the following order:
   *
   * 1. Non-anonymous events coming from the contract itself (these will moreover be ordered
   *   from most derived to most base)
   * 2. Non-anonymous events coming from libraries
   * 3. Anonymous events coming from the contract itself (again, ordered from most derived
   *   to most base)
   * 4. Anonymous events coming from libraries
   *
   * You can check the kind and class.contractKind fields to distinguish between these.
   *
   * If no possible decodings are found, the returned array of decodings will be empty.
   *
   * Note that different decodings may use different decoding modes.
   *
   * Changing `options.extras = "on"` or `options.extras = "necessary"` will change the
   * above behavior; see the documentation on [[ExtrasAllowed]] for more.
   *
   * @param log The log to be decoded.
   * @param options Options for controlling decoding.
   */
  public async decodeLog(
    log: DecoderTypes.Log,
    options: DecoderTypes.DecodeLogOptions = {}
  ): Promise<LogDecoding[]> {
    return await this.decodeLogWithAdditionalOptions(log, options);
  }

  /**
   * @protected
   */
  public async decodeLogWithAdditionalOptions(
    log: DecoderTypes.Log,
    options: DecoderTypes.EventOptions = {},
    additionalContexts: Contexts.Contexts = {}
  ): Promise<LogDecoding[]> {
    const block = log.blockNumber;
    const blockNumber = await this.regularizeBlock(block);
    const data = Conversion.toBytes(log.data);
    const topics = log.topics.map(Conversion.toBytes);
    const info: Evm.EvmInfo = {
      state: {
        storage: {},
        eventdata: data,
        eventtopics: topics
      },
      userDefinedTypes: this.userDefinedTypes,
      allocations: this.allocations,
      contexts: { ...this.deployedContexts, ...additionalContexts }
    };
    const decoder = decodeEvent(info, log.address, options);

    let result = decoder.next();
    while (result.done === false) {
      let request = result.value;
      let response: Uint8Array;
      switch (request.type) {
        case "code":
          response = await this.getCode(request.address, blockNumber);
          break;
        //not writing a storage case as it shouldn't occur here!
      }
      result = decoder.next(response);
    }
    //at this point, result.value holds the final value
    return result.value;
  }

  /**
   * **This method is asynchronous.**
   *
   * Gets all events meeting certain conditions and decodes them.
   * This function is fairly rudimentary at the moment but more functionality
   * will be added in the future.
   * @param options Used to determine what events to fetch and how to decode
   *   them; see the documentation on the [[EventOptions]] type for more.
   * @return An array of [[DecodedLog|DecodedLogs]].
   *   These consist of a log together with its possible decodings; see that
   *   type for more info.  And see [[decodeLog]] for more info on how log
   *   decoding works in general.
   * @example `events({name: "TestEvent"})` -- get events named "TestEvent"
   *   from the most recent block
   */
  public async events(
    options: DecoderTypes.EventOptions = {}
  ): Promise<DecoderTypes.DecodedLog[]> {
    return await this.eventsWithAdditionalContexts(options);
  }

  /**
   * @protected
   */
  public async eventsWithAdditionalContexts(
    options: DecoderTypes.EventOptions = {},
    additionalContexts: Contexts.Contexts = {}
  ): Promise<DecoderTypes.DecodedLog[]> {
    let { address, name, fromBlock, toBlock } = options;
    if (fromBlock === undefined) {
      fromBlock = "latest";
    }
    if (toBlock === undefined) {
      toBlock = "latest";
    }
    const fromBlockNumber = await this.regularizeBlock(fromBlock);
    const toBlockNumber = await this.regularizeBlock(toBlock);

    const logs = await this.providerAdapter.getPastLogs({
      address,
      fromBlock: fromBlockNumber,
      toBlock: toBlockNumber
    });

    let events = await Promise.all(
      logs.map(async log => ({
        ...log,
        decodings: await this.decodeLogWithAdditionalOptions(
          log,
          options,
          additionalContexts
        )
      }))
    );
    debug("events: %o", events);

    //if a target name was specified, we'll restrict to events that decoded
    //to something with that name.  (note that only decodings with that name
    //will have been returned from decodeLogs in the first place)
    if (name !== undefined) {
      events = events.filter(event => event.decodings.length > 0);
    }

    return events;
  }

  /**
   * Takes a [[CalldataDecoding]], which may have been produced in full mode or ABI mode,
   * and converts it to its ABI mode equivalent.  See the README for more information.
   *
   * Please only use on decodings produced by this same decoder instance; use
   * on decodings produced by other instances may not work consistently.
   * @param decoding The decoding to abify
   */
  public abifyCalldataDecoding(decoding: CalldataDecoding): CalldataDecoding {
    return Codec.abifyCalldataDecoding(decoding, this.userDefinedTypes);
  }

  /**
   * Takes a [[LogDecoding]], which may have been produced in full mode or ABI mode,
   * and converts it to its ABI mode equivalent.  See the README for more information.
   *
   * Please only use on decodings produced by this same decoder instance; use
   * on decodings produced by other instances may not work consistently.
   * @param decoding The decoding to abify
   */
  public abifyLogDecoding(decoding: LogDecoding): LogDecoding {
    return Codec.abifyLogDecoding(decoding, this.userDefinedTypes);
  }

  /**
   * Takes a [[ReturndataDecoding]], which may have been produced in full mode
   * or ABI mode, and converts it to its ABI mode equivalent.  See the README
   * for more information.
   *
   * Please only use on decodings produced by this same decoder instance; use
   * on decodings produced by other instances may not work consistently.
   * @param decoding The decoding to abify
   */
  public abifyReturndataDecoding(
    decoding: ReturndataDecoding
  ): ReturndataDecoding {
    return Codec.abifyReturndataDecoding(decoding, this.userDefinedTypes);
  }

  //normally, this function gets the code of the given address at the given block,
  //and checks this against the known contexts to determine the contract type
  //however, if this fails and constructorBinary is passed in, it will then also
  //attempt to determine it from that
  private async getContextByAddress(
    address: string,
    block: DecoderTypes.RegularizedBlockSpecifier,
    constructorBinary?: string,
    additionalContexts: Contexts.Contexts = {}
  ): Promise<Contexts.Context | null> {
    let code: string;
    if (address !== null) {
      code = Conversion.toHexString(await this.getCode(address, block));
    } else if (constructorBinary) {
      code = constructorBinary;
    }
    //if neither of these hold... we have a problem
    let contexts = { ...this.contexts, ...additionalContexts };
    return Contexts.Utils.findContext(contexts, code);
  }

  //finally: the spawners!

  /**
   * **This method is asynchronous.**
   *
   * Constructs a contract decoder for a given contract artifact.
   * @param artifact The artifact for the contract.
   *
   *   A contract constructor object may be substituted for the artifact, so if
   *   you're not sure which you're dealing with, it's OK.
   *
   *   Note: The artifact must be for a contract that the decoder knows about;
   *   otherwise you will have problems.
   */

  public async forArtifact(artifact: Artifact): Promise<ContractDecoder> {
    const deployedBytecode = Shims.NewToLegacy.forBytecode(
      artifact.deployedBytecode
    );
    const bytecode = Shims.NewToLegacy.forBytecode(artifact.bytecode);

    const { compilation, contract } = this.compilations.reduce(
      (foundSoFar: DecoderTypes.CompilationAndContract, compilation) => {
        if (foundSoFar) {
          return foundSoFar;
        }
        const contractFound = compilation.contracts.find(contract => {
          if (bytecode) {
            return (
              Shims.NewToLegacy.forBytecode(contract.bytecode) === bytecode &&
              contract.contractName ===
                (artifact.contractName || <string>artifact.contract_name)
            );
          } else if (deployedBytecode) {
            //I'll just go by one of bytecode or deployedBytecode;
            //no real need to check both
            return (
              Shims.NewToLegacy.forBytecode(contract.deployedBytecode) ===
                deployedBytecode &&
              contract.contractName ===
                (artifact.contractName || <string>artifact.contract_name)
            );
          } else {
            //WARNING: better hope we don't end up here!
            return (
              contract.contractName ===
              (artifact.contractName || <string>artifact.contract_name)
            );
          }
        });
        if (contractFound) {
          return { compilation, contract: contractFound };
        } else {
          return undefined;
        }
      },
      undefined
    );

    if (contract === undefined) {
      throw new ContractNotFoundError(
        artifact.contractName,
        bytecode,
        deployedBytecode,
        undefined
      );
    }

    let contractDecoder = new ContractDecoder(
      contract,
      compilation,
      this,
      artifact
    );
    await contractDecoder.init();
    return contractDecoder;
  }

  /**
   * **This method is asynchronous.**
   *
   * Constructs a contract instance decoder for a given instance of a contract in this
   * project.
   * @param artifact The artifact for the contract.
   *
   *   A contract constructor object may be substituted for the artifact, so if
   *   you're not sure which you're dealing with, it's OK.
   *
   *   Note: The artifact must be for a contract that the decoder knows about;
   *   otherwise you will have problems.
   * @param address The address of the contract instance to decode.  If left out, it will be autodetected.
   *   If an invalid address is provided, this method will throw an exception.
   */
  public async forInstance(
    artifact: Artifact,
    address?: string
  ): Promise<ContractInstanceDecoder> {
    let contractDecoder = await this.forArtifact(artifact);
    return await contractDecoder.forInstance(address);
  }

  /**
   * **This method is asynchronous.**
   *
   * Constructs a contract instance decoder for a given instance of a contract in this
   * project.  Unlike [[forInstance]], this method doesn't require an artifact; it
   * will automatically detect the class of the given contract.  If it's not in
   * the project, or the decoder can't identify it, you'll get an exception.
   * @param address The address of the contract instance to decode.
   *   If an invalid address is provided, this method will throw an exception.
   * @param block You can include this argument to specify that this should be
   *   based on the addresses content's at a specific block (if say the contract
   *   has since self-destructed).
   */
  public async forAddress(
    address: string,
    block: DecoderTypes.BlockSpecifier = "latest"
  ): Promise<ContractInstanceDecoder> {
    if (!Web3Utils.isAddress(address)) {
      throw new InvalidAddressError(address);
    }
    address = Web3Utils.toChecksumAddress(address);
    const blockNumber = await this.regularizeBlock(block);
    const deployedBytecode = Conversion.toHexString(
      await this.getCode(address, blockNumber)
    );
    const contractAndContexts = this.contractsAndContexts.find(
      ({ deployedContext }) =>
        deployedContext &&
        Contexts.Utils.matchContext(deployedContext, deployedBytecode)
    );
    if (!contractAndContexts) {
      throw new ContractNotFoundError(
        undefined,
        undefined,
        deployedBytecode,
        address
      );
    }
    const { contract, compilationId } = contractAndContexts;
    const compilation = this.compilations.find(
      compilation => compilation.id === compilationId
    );
    let contractDecoder = new ContractDecoder(contract, compilation, this); //no artifact
    //(artifact is only used for address autodetection, and here we're supplying the
    //address, so this won't cause any problems)
    await contractDecoder.init();
    return await contractDecoder.forInstance(address);
  }

  //the following functions are intended for internal use only

  /**
   * @protected
   */
  public getReferenceDeclarations(): { [compilationId: string]: Ast.AstNodes } {
    return this.referenceDeclarations;
  }

  /**
   * @protected
   */
  public getUserDefinedTypes(): Format.Types.TypesById {
    return this.userDefinedTypes;
  }

  /**
   * @protected
   */
  public getAllocations(): Evm.AllocationInfo {
    return this.allocations;
  }

  /**
   * @protected
   */
  public getProviderAdapter(): ProviderAdapter {
    return this.providerAdapter;
  }

  /**
   * @protected
   */
  public getEnsSettings(): DecoderTypes.EnsSettings {
    return this.ensSettings;
  }

  /**
   * @protected
   */
  public getDeployedContexts(): Contexts.Contexts {
    return this.deployedContexts;
  }
}

/**
 * The ContractDecoder class.  Decodes return values, and spawns the
 * [[ContractInstanceDecoder]] class.  Also, decodes transactions logs.  See
 * below for a method listing.
 * @category Decoder
 */
export class ContractDecoder {
  private providerAdapter: ProviderAdapter;

  private contexts: Contexts.Contexts; //note: this is deployed contexts only!

  private compilation: Compilations.Compilation;
  private contract: Compilations.Contract;
  private artifact: Artifact;
  private contractNode: Ast.AstNode;
  private contractNetwork: string;
  private contextHash: string;

  private allocations: Codec.Evm.AllocationInfo;
  private noBytecodeAllocations: {
    [selector: string]: AbiData.Allocate.CalldataAndReturndataAllocation;
  };
  private userDefinedTypes: Format.Types.TypesById;
  private stateVariableReferences: Storage.Allocate.StateVariableAllocation[];

  private projectDecoder: ProjectDecoder;

  /**
   * @protected
   */
  constructor(
    contract: Compilations.Contract,
    compilation: Compilations.Compilation,
    projectDecoder: ProjectDecoder,
    artifact?: Artifact
  ) {
    this.artifact = artifact; //may be undefined; only used for address autodetection in instance decoder
    this.contract = contract;
    this.compilation = compilation;
    this.projectDecoder = projectDecoder;
    this.providerAdapter = projectDecoder.getProviderAdapter();
    this.contexts = projectDecoder.getDeployedContexts();
    this.userDefinedTypes = this.projectDecoder.getUserDefinedTypes();

    this.contractNode = Compilations.Utils.getContractNode(
      this.contract,
      this.compilation
    );
    this.allocations = this.projectDecoder.getAllocations();

    //note: ordinarily this.contract.deployedBytecode should equal artifact.deployedBytecode
    //at this point, so it may seem strange that I'm using this longer version (but not
    //doing anything to handle the case we're there not).  This is basically because I don't
    //think such error handling is really necessary right now, but this way at least it won't
    //crash.
    if (
      this.contract.deployedBytecode &&
      this.contract.deployedBytecode !== "0x"
    ) {
      const unnormalizedContext = Contexts.Utils.makeContext(
        this.contract,
        this.contractNode,
        this.compilation
      );
      this.contextHash = unnormalizedContext.context;
      //we now throw away the unnormalized context, instead fetching the correct one from
      //this.contexts (which is normalized) via the context getter below
    } else {
      //if there's no bytecode, allocate output data in ABI mode anyway
      const referenceDeclarations =
        this.projectDecoder.getReferenceDeclarations();
      const compiler = this.compilation.compiler || this.contract.compiler;
      this.noBytecodeAllocations = Object.values(
        AbiData.Allocate.getCalldataAllocations(
          [
            {
              abi: Abi.normalize(this.contract.abi),
              compilationId: this.compilation.id,
              compiler,
              contractNode: this.contractNode,
              deployedContext: Contexts.Utils.makeContext(
                {
                  ...this.contract,
                  deployedBytecode: "0x" //only time this should ever appear in a context!
                  //note that we immediately discard it!
                },
                this.contractNode,
                this.compilation
              )
            }
          ],
          referenceDeclarations,
          this.userDefinedTypes,
          this.allocations.abi
        ).functionAllocations
      )[0];
    }

    if (this.contractNode) {
      //note: there used to be code here to do state allocations for the contract,
      //but now the project decoder does this all up-front
      //(I could change this back if for some reason performance is an issue,
      //but this way is simpler TBH)
      //NOTE: does this change make this intermediate class essentially pointless?
      //Yes.  But not going to get rid of it now!

      if (
        this.allocations.state[this.compilation.id] &&
        this.allocations.state[this.compilation.id][this.contractNode.id]
      ) {
        this.stateVariableReferences =
          this.allocations.state[this.compilation.id][
            this.contractNode.id
          ].members;
      }
      //if it doesn't exist, we will leave it undefined, and then throw an exception when
      //we attempt to decode
    }
  }

  /**
   * @protected
   */
  public async init(): Promise<void> {
    this.contractNetwork = await this.providerAdapter.getNetworkId();
  }

  private get context(): Contexts.Context {
    return this.contexts[this.contextHash];
  }

  /**
   * **This method is asynchronous.**
   *
   * Decodes the return value of a call.  Return values can be ambiguous, so this so
   * this function returns an array of [[ReturndataDecoding|ReturndataDecodings]].
   *
   * Note that return values are decoded in strict mode, so none of the decodings should
   * contain errors; if a decoding would contain an error, instead it is simply excluded from the
   * list of possible decodings.
   *
   * If there are multiple possible decodings, they will always be listed in the following order:
   * 1. The decoded return value from a successful call.
   * 2. The decoded revert message from a call that reverted with a message.
   * 3. A decoding indicating that the call reverted with no message.
   * 4. A decoding indicating that the call self-destructed.
   *
   * You can check the kind and field to distinguish between these.
   *
   * If no possible decodings are found, the returned array of decodings will be empty.
   *
   * Note that different decodings may use different decoding modes.
   *
   * Decoding creation calls with this method is not supported.  If you simply
   * want to decode a revert message from an arbitrary call that you know
   * failed, you may also want to see the [[decodeRevert]] function in
   * `@truffle/codec`.
   *
   * @param abi The abi entry for the function call whose return value is being decoded.
   * @param data The data to be decoded, as a hex string (beginning with "0x").
   * @param options Additional options, such as the block the call occurred in.
   *   See [[ReturnOptions]] for more information.
   */
  public async decodeReturnValue(
    abi: Abi.FunctionEntry,
    data: string,
    options: DecoderTypes.ReturnOptions = {}
  ): Promise<ReturndataDecoding[]> {
    return await this.decodeReturnValueWithAdditionalContexts(
      abi,
      data,
      options
    );
  }

  /**
   * @protected
   */
  public async decodeReturnValueWithAdditionalContexts(
    abi: Abi.FunctionEntry,
    data: string,
    options: DecoderTypes.ReturnOptions = {},
    additionalContexts: Contexts.Contexts = {}
  ): Promise<ReturndataDecoding[]> {
    abi = <Abi.FunctionEntry>Abi.normalizeEntry(abi); //just to be absolutely certain!
    const block = options.block !== undefined ? options.block : "latest";
    const blockNumber = await this.regularizeBlock(block);
    const status = options.status; //true, false, or undefined

    const selector = AbiData.Utils.abiSelector(abi);
    let allocation: AbiData.Allocate.ReturndataAllocation;
    if (this.contextHash !== undefined) {
      allocation =
        this.allocations.calldata.functionAllocations[this.contextHash][
          selector
        ].output;
    } else {
      allocation = this.noBytecodeAllocations[selector].output;
    }

    debug("this.allocations: %O", this.allocations);
    const bytes = Conversion.toBytes(data);
    const info: Evm.EvmInfo = {
      state: {
        storage: {},
        returndata: bytes
      },
      userDefinedTypes: this.userDefinedTypes,
      allocations: this.allocations,
      contexts: { ...this.contexts, ...additionalContexts },
      currentContext: this.context
    };

    const decoder = decodeReturndata(info, allocation, status);

    let result = decoder.next();
    while (result.done === false) {
      let request = result.value;
      let response: Uint8Array;
      switch (request.type) {
        case "code":
          response = await this.getCode(request.address, blockNumber);
          break;
        //not writing a storage case as it shouldn't occur here!
      }
      result = decoder.next(response);
    }
    //at this point, result.value holds the final value
    return result.value;
  }

  /**
   * **This method is asynchronous.**
   *
   * Constructs a contract instance decoder for a given instance of this contract.
   * @param address The address of the contract instance decode.  If left out, it will be autodetected.
   *   If an invalid address is provided, this method will throw an exception.
   */
  public async forInstance(address?: string): Promise<ContractInstanceDecoder> {
    let instanceDecoder = new ContractInstanceDecoder(this, address);
    await instanceDecoder.init();
    return instanceDecoder;
  }

  private async getCode(
    address: string,
    block: DecoderTypes.RegularizedBlockSpecifier
  ): Promise<Uint8Array> {
    return await this.projectDecoder.getCode(address, block);
  }

  private async regularizeBlock(
    block: DecoderTypes.BlockSpecifier
  ): Promise<DecoderTypes.RegularizedBlockSpecifier> {
    return await this.projectDecoder.regularizeBlock(block);
  }

  /**
   * **This method is asynchronous.**
   *
   * See [[ProjectDecoder.decodeTransaction]].
   * @param transaction The transaction to be decoded.
   */
  public async decodeTransaction(
    transaction: DecoderTypes.Transaction
  ): Promise<CalldataDecoding> {
    return await this.projectDecoder.decodeTransaction(transaction);
  }

  /**
   * **This method is asynchronous.**
   *
   * See [[ProjectDecoder.decodeLog]].
   * @param log The log to be decoded.
   */
  public async decodeLog(
    log: DecoderTypes.Log,
    options: DecoderTypes.DecodeLogOptions = {}
  ): Promise<LogDecoding[]> {
    return await this.projectDecoder.decodeLog(log, options);
  }

  /**
   * **This method is asynchronous.**
   *
   * See [[ProjectDecoder.events]].
   * @param options Used to determine what events to fetch and how to decode them;
   *   see the documentation on the EventOptions type for more.
   */
  public async events(
    options: DecoderTypes.EventOptions = {}
  ): Promise<DecoderTypes.DecodedLog[]> {
    return await this.projectDecoder.events(options);
  }

  /**
   * See [[ProjectDecoder.abifyCalldataDecoding]].
   */
  public abifyCalldataDecoding(decoding: CalldataDecoding): CalldataDecoding {
    return this.projectDecoder.abifyCalldataDecoding(decoding);
  }

  /**
   * See [[ProjectDecoder.abifyLogDecoding]].
   */
  public abifyLogDecoding(decoding: LogDecoding): LogDecoding {
    return this.projectDecoder.abifyLogDecoding(decoding);
  }

  /**
   * See [[ProjectDecoder.abifyReturndataDecoding]].
   */
  public abifyReturndataDecoding(
    decoding: ReturndataDecoding
  ): ReturndataDecoding {
    return this.projectDecoder.abifyReturndataDecoding(decoding);
  }

  //the following functions are for internal use

  /**
   * @protected
   */
  public getAllocations() {
    return this.allocations;
  }

  /**
   * @protected
   */
  public getStateVariableReferences() {
    return this.stateVariableReferences;
  }

  /**
   * @protected
   */
  public getProjectDecoder() {
    return this.projectDecoder;
  }

  /**
   * @protected
   */
  public getContractInfo(): DecoderTypes.ContractInfo {
    return {
      compilation: this.compilation,
      contract: this.contract,
      artifact: this.artifact,
      contractNode: this.contractNode,
      contractNetwork: this.contractNetwork,
      contextHash: this.contextHash
    };
  }
}

/**
 * The ContractInstanceDecoder class.  Decodes storage for a specified
 * instance.  Also, decodes transactions, logs, and return values.  See below
 * for a method listing.
 *
 * Note that when using this class to decode transactions, logs, and return
 * values, it does have one advantage over using the ProjectDecoder or
 * ContractDecoder.  If the artifact for the class does not have a
 * deployedBytecode field, the ProjectDecoder (and therefore also the
 * ContractDecoder) will not be able to tell that this instance is of that
 * class, and so will fail to decode transactions sent to it or logs
 * originating from it, and will fall back to ABI mode when decoding return
 * values received from it.  However, the ContractInstanceDecoder has that
 * information and will make use of it, making it possible for it to decode
 * transactions sent to this instance, or logs originating from it, or decode
 * return values received from it in full mode, even if the deployedBytecode
 * field is misssing.
 * @category Decoder
 */
export class ContractInstanceDecoder {
  private providerAdapter: ProviderAdapter;

  private compilation: Compilations.Compilation;
  private contract: Compilations.Contract;
  private contractNode: Ast.AstNode;
  private contractNetwork: string;
  private contractAddress: string;
  private contractCode: string;
  private contextHash: string;
  private compiler: Compiler.CompilerVersion;

  private contexts: Contexts.Contexts = {}; //deployed contexts only
  private additionalContexts: Contexts.Contexts = {}; //for passing to project decoder when contract has no deployedBytecode

  private referenceDeclarations: { [compilationId: string]: Ast.AstNodes };
  private userDefinedTypes: Format.Types.TypesById;
  private allocations: Codec.Evm.AllocationInfo;

  private stateVariableReferences: Storage.Allocate.StateVariableAllocation[];
  private internalFunctionsTable: Codec.Evm.InternalFunctions;

  private mappingKeys: Storage.Slot[] = [];

  private storageCache: DecoderTypes.StorageCache = {};

  private contractDecoder: ContractDecoder;
  private projectDecoder: ProjectDecoder;

  /**
   * @protected
   */
  constructor(contractDecoder: ContractDecoder, address?: string) {
    this.contractDecoder = contractDecoder;
    this.projectDecoder = this.contractDecoder.getProjectDecoder();
    this.providerAdapter = this.projectDecoder.getProviderAdapter();
    if (address !== undefined) {
      if (!Web3Utils.isAddress(address)) {
        throw new InvalidAddressError(address);
      }
      this.contractAddress = Web3Utils.toChecksumAddress(address);
    }

    this.referenceDeclarations = this.projectDecoder.getReferenceDeclarations();
    this.userDefinedTypes = this.projectDecoder.getUserDefinedTypes();
    this.contexts = this.projectDecoder.getDeployedContexts();
    let artifact: Artifact;
    ({
      compilation: this.compilation,
      contract: this.contract,
      artifact,
      contractNode: this.contractNode,
      contractNetwork: this.contractNetwork,
      contextHash: this.contextHash
    } = this.contractDecoder.getContractInfo());

    this.allocations = this.contractDecoder.getAllocations();
    this.stateVariableReferences =
      this.contractDecoder.getStateVariableReferences();

    //note that if we're in the null artifact case, this.contractAddress should have
    //been set by now, so we shouldn't end up here
    if (this.contractAddress === undefined) {
      this.contractAddress = artifact.networks[this.contractNetwork].address;
    }

    this.compiler = this.compilation.compiler || this.contract.compiler;
  }

  /**
   * @protected
   */
  public async init(): Promise<void> {
    this.contractCode = Conversion.toHexString(
      await this.getCode(
        this.contractAddress,
        await this.providerAdapter.getBlockNumber() //not "latest" because regularized
      )
    );

    const deployedBytecode = Shims.NewToLegacy.forBytecode(
      this.contract.deployedBytecode
    );

    if (!deployedBytecode || deployedBytecode === "0x") {
      //if this contract does *not* have the deployedBytecode field, then the decoder core
      //has no way of knowing that contracts or function pointers with its address
      //are of its class; this is an especial problem for function pointers, as it
      //won't be able to determine what the selector points to.
      //so, to get around this, we make an "additional context" for the contract,
      //based on its *actual* deployed bytecode as pulled from the blockchain.
      //This way the decoder core can recognize the address as the class, without us having
      //to make serious modifications to contract decoding.  And while sure this requires
      //a little more work, I mean, it's all cached, so, no big deal.
      const contractWithCode = {
        ...this.contract,
        deployedBytecode: this.contractCode
      };
      const extraContext = Contexts.Utils.makeContext(
        contractWithCode,
        this.contractNode,
        this.compilation
      );
      this.contextHash = extraContext.context;
      this.additionalContexts = { [extraContext.context]: extraContext };
      //the following line only has any effect if we're dealing with a library,
      //since the code we pulled from the blockchain obviously does not have unresolved link references!
      //(it's not strictly necessary even then, but, hey, why not?)
      this.additionalContexts = Contexts.Utils.normalizeContexts(
        this.additionalContexts
      );
      //again, since the code did not have unresolved link references, it is safe to just
      //mash these together like I'm about to
      this.contexts = { ...this.contexts, ...this.additionalContexts };
    }

    //finally: set up internal functions table (only if source order is reliable;
    //otherwise leave as undefined)
    //unlike the debugger, we don't *demand* an answer, so we won't set up
    //some sort of fake table if we don't have a source map, or if any ASTs are missing
    //(if a whole *source* is missing, we'll consider that OK)
    //note: we don't attempt to handle Vyper source maps!
    const compiler = this.compilation.compiler || this.contract.compiler;
    if (
      !this.compilation.unreliableSourceOrder &&
      this.contract.deployedSourceMap &&
      compiler.name === "solc" &&
      this.compilation.sources.every(source => !source || source.ast)
    ) {
      //WARNING: untyped code in this block!
      let asts: Ast.AstNode[] = this.compilation.sources.map(source =>
        source ? source.ast : undefined
      );
      let instructions = SourceMapUtils.getProcessedInstructionsForBinary(
        this.compilation.sources.map(source =>
          source ? source.source : undefined
        ),
        this.contractCode,
        SourceMapUtils.getHumanReadableSourceMap(
          this.contract.deployedSourceMap
        )
      );
      try {
        //this can fail if some of the source files are missing :(
        this.internalFunctionsTable =
          SourceMapUtils.getFunctionsByProgramCounter(
            instructions,
            asts,
            asts.map(SourceMapUtils.makeOverlapFunction),
            this.compilation.id
          );
      } catch (_) {
        //just leave the internal functions table undefined
      }
    }
  }

  private get context(): Contexts.Context {
    return this.contexts[this.contextHash];
  }

  private checkAllocationSuccess(): void {
    if (!this.contractNode) {
      throw new ContractBeingDecodedHasNoNodeError(
        this.contract.contractName,
        this.compilation.id
      );
    }
    if (!this.stateVariableReferences) {
      throw new ContractAllocationFailedError(
        this.contractNode.id,
        this.contract.contractName,
        this.compilation.id
      );
    }
  }

  private async decodeVariable(
    variable: Storage.Allocate.StateVariableAllocation,
    block: DecoderTypes.RegularizedBlockSpecifier
  ): Promise<DecoderTypes.StateVariable> {
    const info: Codec.Evm.EvmInfo = {
      state: {
        storage: {},
        code: Conversion.toBytes(this.contractCode)
      },
      mappingKeys: this.mappingKeys,
      userDefinedTypes: this.userDefinedTypes,
      allocations: this.allocations,
      contexts: this.contexts,
      currentContext: this.context,
      internalFunctionsTable: this.internalFunctionsTable
    };
    debug("this.contextHash: %s", this.contextHash);

    const decoder = Codec.decodeVariable(
      variable.definition,
      variable.pointer,
      info,
      this.compilation.id
    );

    let result = decoder.next();
    while (result.done === false) {
      let request = result.value;
      let response: Uint8Array;
      switch (request.type) {
        case "storage":
          response = await this.getStorage(
            this.contractAddress,
            request.slot,
            block
          );
          break;
        case "code":
          response = await this.getCode(request.address, block);
          break;
      }
      result = decoder.next(response);
    }
    //at this point, result.value holds the final value

    debug("definedIn: %o", variable.definedIn);
    let classType = Ast.Import.definitionToStoredType(
      variable.definedIn,
      this.compilation.id,
      this.compiler
    ); //can skip reference decls

    return {
      name: variable.definition.name,
      class: <Format.Types.ContractType>classType,
      value: result.value
    };
  }

  /**
   * **This method is asynchronous.**
   *
   * Returns information about the state of the contract, but does not include
   * information about the storage or decoded variables.  See the documentation
   * for the [[ContractState]] type for more.
   * @param block The block to inspect the contract's state at.  Defaults to latest.
   *   See [[BlockSpecifier]] for legal values.
   */
  public async state(
    block: DecoderTypes.BlockSpecifier = "latest"
  ): Promise<DecoderTypes.ContractState> {
    let blockNumber = await this.regularizeBlock(block);
    return {
      class: Contexts.Import.contextToType(this.context),
      address: this.contractAddress,
      code: this.contractCode,
      balanceAsBN: new BN(
        await this.providerAdapter.getBalance(this.contractAddress, blockNumber)
      ),
      nonceAsBN: new BN(
        await this.providerAdapter.getTransactionCount(
          this.contractAddress,
          blockNumber
        )
      )
    };
  }

  /**
   * **This method is asynchronous.**
   *
   * Decodes the contract's variables; returns an array of these decoded variables.
   * See the documentation of the [[DecodedVariable]] type for more.
   *
   * Note that variable decoding can only operate in full mode; if the decoder wasn't able to
   * start up in full mode, this method will throw a [[ContractAllocationFailedError]].
   *
   * Note that decoding mappings requires first watching mapping keys in order to get any results;
   * see the documentation for [[watchMappingKey]].
   * Additional methods to make mapping decoding a less manual affair are planned for the future.
   *
   * Also, due to a technical limitation, it is not currently possible to
   * usefully decode internal function pointers.  See the
   * [[Format.Values.FunctionInternalValue|FunctionInternalValue]]
   * documentation and the README for more on how these are handled.
   * @param block The block to inspect the contract's state at.  Defaults to latest.
   *   See [[BlockSpecifier]] for legal values.
   */
  public async variables(
    block: DecoderTypes.BlockSpecifier = "latest"
  ): Promise<DecoderTypes.StateVariable[]> {
    this.checkAllocationSuccess();

    let blockNumber = await this.regularizeBlock(block);

    let result: DecoderTypes.StateVariable[] = [];

    for (const variable of this.stateVariableReferences) {
      debug("about to decode %s", variable.definition.name);
      const decodedVariable = await this.decodeVariable(variable, blockNumber);
      debug("decoded");

      result.push(decodedVariable);
    }

    return result;
  }

  /**
   * **This method is asynchronous.**
   *
   * Decodes an individual contract variable; returns its value as a
   * [[Format.Values.Result|Result]].  See the documentation for
   * [[variables|variables()]] for various caveats that also apply here.
   *
   * If the variable can't be located, throws an exception.
   * @param nameOrId The name (or numeric ID, if you know that) of the
   *   variable.  Can be given as a qualified name, allowing one to get at
   *   shadowed variables from base contracts.  If given by ID, can be given as a
   *   number or numeric string.
   * @param block The block to inspect the contract's state at.  Defaults to latest.
   *   See [[BlockSpecifier]] for legal values.
   * @example Consider a contract `Derived` inheriting from a contract `Base`.
   *   Suppose `Derived` has a variable `x` and `Base` has variables `x` and
   *   `y`.  One can access `Derived.x` as `variable("x")` or
   *   `variable("Derived.x")`, can access `Base.x` as `variable("Base.x")`,
   *   and can access `Base.y` as `variable("y")` or `variable("Base.y")`.
   */
  public async variable(
    nameOrId: string | number,
    block: DecoderTypes.BlockSpecifier = "latest"
  ): Promise<Format.Values.Result | undefined> {
    this.checkAllocationSuccess();

    let blockNumber = await this.regularizeBlock(block);

    let variable = this.findVariableByNameOrId(nameOrId);

    if (variable === undefined) {
      //if user put in a bad name
      throw new VariableNotFoundError(nameOrId);
    }

    return (await this.decodeVariable(variable, blockNumber)).value;
  }

  private findVariableByNameOrId(
    nameOrId: string | number
  ): Storage.Allocate.StateVariableAllocation | undefined {
    //case 1: an ID was input
    if (typeof nameOrId === "number" || nameOrId.match(/[0-9]+/)) {
      return this.stateVariableReferences.find(
        ({ definition }) => definition.id === nameOrId
      );
      //there should be exactly one; returns undefined if none
    }
    //case 2: a name was input
    else if (!nameOrId.includes(".")) {
      //we want to search *backwards*, to get most derived version;
      //we use slice().reverse() to clone before reversing since reverse modifies
      return this.stateVariableReferences
        .slice()
        .reverse()
        .find(({ definition }) => definition.name === nameOrId);
    }
    //case 3: a qualified name was input
    else {
      let [className, variableName] = nameOrId.split(".");
      //again, we'll search backwards, although, uhhh...?
      return this.stateVariableReferences
        .slice()
        .reverse()
        .find(
          ({ definition, definedIn }) =>
            definition.name === variableName && definedIn.name === className
        );
    }
  }

  private async getStorage(
    address: string,
    slot: BN,
    block: DecoderTypes.RegularizedBlockSpecifier
  ): Promise<Uint8Array> {
    //if pending, bypass the cache
    if (block === "pending") {
      return Conversion.toBytes(
        await this.providerAdapter.getStorageAt(address, slot, block),
        Codec.Evm.Utils.WORD_SIZE
      );
    }

    //otherwise, start by setting up any preliminary layers as needed
    if (this.storageCache[block] === undefined) {
      this.storageCache[block] = {};
    }
    if (this.storageCache[block][address] === undefined) {
      this.storageCache[block][address] = {};
    }
    //now, if we have it cached, just return it
    if (this.storageCache[block][address][slot.toString()] !== undefined) {
      return this.storageCache[block][address][slot.toString()];
    }
    //otherwise, get it, cache it, and return it
    let word = Conversion.toBytes(
      await this.providerAdapter.getStorageAt(address, slot, block),
      Codec.Evm.Utils.WORD_SIZE
    );
    this.storageCache[block][address][slot.toString()] = word;
    return word;
  }

  private async getCode(
    address: string,
    block: DecoderTypes.RegularizedBlockSpecifier
  ): Promise<Uint8Array> {
    return await this.projectDecoder.getCode(address, block);
  }

  private async regularizeBlock(
    block: DecoderTypes.BlockSpecifier
  ): Promise<DecoderTypes.RegularizedBlockSpecifier> {
    return await this.projectDecoder.regularizeBlock(block);
  }

  /**
   * **This method is asynchronous.**
   *
   * Watches a mapping key; adds it to the decoder's list of watched mapping
   * keys.  This affects the results of both [[variables|variables()]] and
   * [[variable|variable()]].  When a mapping is decoded, only the values at
   * its watched keys will be included in its value.
   *
   * Note that it is possible
   * to watch mappings that are inside structs, arrays, other mappings, etc;
   * see below for more on how to do this.
   *
   * Note that watching mapping keys is
   * only possible in full mode; if the decoder wasn't able to start up in full
   * mode, this method will throw an exception.
   *
   * **Warning**: At the moment, this function does very little to check its
   * input.  Bad input may have unpredictable results.  This will be remedied
   * in the future (by having it throw exceptions on bad input), but right now
   * essentially no checking is implemented.  Also, there may be slight changes
   * to the format of indices in the future.
   *
   * (A bad variable name will cause an exception though; that input is checked.)
   * @param variable The variable that the mapping lives under; this works like
   *   the nameOrId argument to [[variable|variable()]].  If the mapping is a
   *   top-level state variable, put the mapping itself here.  Otherwise, put the
   *   top-level state variable it lives under.
   * @param indices Further arguments to watchMappingKey, if given, will be
   *   interpreted as indices into or members of the variable identified by the
   *   variable argument; see the example.  Array indices and mapping
   *   keys are specified by value; struct members are specified by name.
   *
   *   Numeric values can be given as number, BN, or
   *   numeric string.  Bytestring values are given as hex strings.  Boolean
   *   values are given as booleans, or as the strings "true" or "false".
   *   Address values are given as hex strings; they are currently not required
   *   to be in checksum case, but this will likely change in the future, so
   *   don't rely on that.  Contract values work like address values.
   *   Enum values can be given either as a numeric value or by name;
   *   in the latter case you can use either a qualified name or just the
   *   name of the option (i.e., you can just write `"Option"` rather than
   *   `"Enum.Option"` or `"Contract.Enum.Option"`, but those will work too).
   *
   *   Note that if the path to a given mapping key
   *   includes mapping keys above it, any ancestors will also be watched
   *   automatically.
   * @example First, a simple example.  Say we have a mapping `m` of type
   *   `mapping(uint => uint)`.  You could call `watchMappingKey("m", 0)` to
   *   watch `m[0]`.
   * @example Now for a slightly more complicated example.  Say `m` is of type
   *   `mapping(uint => mapping(uint => uint))`, then to watch `m[3][5]`, you
   *   can call `watchMappingKey("m", 3, 5)`.  This will also automatically
   *   watch `m[3]`; otherwise, watching `m[3][5]` wouldn't do much of
   *   anything.
   * @example Now for a well more complicated example.  Say we have a struct
   *   type `MapStruct` with a member called `map` which is a `mapping(string => string)`,
   *   and say we have a variable `arr` of type `MapStruct[]`, then one could
   *   watch `arr[3].map["hello"]` by calling `watchMappingKey("arr", 3, "map", "hello")`.
   */
  public async watchMappingKey(
    variable: number | string,
    ...indices: any[]
  ): Promise<void> {
    this.checkAllocationSuccess();
    let { slot } = await this.constructSlot(variable, ...indices);
    //add mapping key and all ancestors
    debug("slot: %O", slot);
    while (
      slot !== undefined &&
      this.mappingKeys.every(
        existingSlot => !Storage.Utils.equalSlots(existingSlot, slot)
        //we put the newness requirement in the while condition rather than a
        //separate if because if we hit one ancestor that's not new, the futher
        //ones won't be either
      )
    ) {
      if (slot.key !== undefined) {
        //only add mapping keys
        this.mappingKeys = [...this.mappingKeys, slot];
      }
      slot = slot.path;
    }
  }

  /**
   * **This method is asynchronous.**
   *
   * Opposite of [[watchMappingKey]]; unwatches the specified mapping key.  See
   * watchMappingKey for more on how watching mapping keys works, and on how
   * the parameters work.
   *
   * Note that unwatching a mapping key will also unwatch all its descendants.
   * E.g., if `m` is of type `mapping(uint => mapping(uint => uint))`, then
   * unwatching `m[0]` will also unwatch `m[0][0]`, `m[0][1]`, etc, if these
   * are currently watched
   *
   * This function has the same caveats as watchMappingKey.
   */
  public async unwatchMappingKey(
    variable: number | string,
    ...indices: any[]
  ): Promise<void> {
    this.checkAllocationSuccess();
    let { slot } = await this.constructSlot(variable, ...indices);
    if (slot === undefined) {
      return; //not strictly necessary, but may as well
    }
    //remove mapping key and all descendants
    this.mappingKeys = this.mappingKeys.filter(existingSlot => {
      while (existingSlot !== undefined) {
        if (Storage.Utils.equalSlots(existingSlot, slot)) {
          return false; //if it matches, remove it
        }
        existingSlot = existingSlot.path;
      }
      return true; //if we didn't match, keep the key
    });
  }
  //NOTE: if you decide to add a way to remove a mapping key *without* removing
  //all descendants, you'll need to alter watchMappingKey to use an if rather
  //than a while

  /**
   * **This method is asynchronous.**
   *
   * See [[ProjectDecoder.decodeTransaction]].
   */
  public async decodeTransaction(
    transaction: DecoderTypes.Transaction
  ): Promise<CalldataDecoding> {
    return await this.projectDecoder.decodeTransactionWithAdditionalContexts(
      transaction,
      this.additionalContexts
    );
  }

  /**
   * **This method is asynchronous.**
   *
   * See [[ProjectDecoder.decodeLog]].
   */
  public async decodeLog(
    log: DecoderTypes.Log,
    options: DecoderTypes.DecodeLogOptions = {}
  ): Promise<LogDecoding[]> {
    return await this.projectDecoder.decodeLogWithAdditionalOptions(
      log,
      options,
      this.additionalContexts
    );
  }

  /**
   * **This method is asynchronous.**
   *
   * See [[ContractDecoder.decodeReturnValue]].
   *
   * If the contract artifact is missing its bytecode, using this method,
   * rather than the one in [[ContractDecoder]], can sometimes provide
   * additional decoding information.
   */
  public async decodeReturnValue(
    abi: Abi.FunctionEntry,
    data: string,
    options: DecoderTypes.ReturnOptions = {}
  ): Promise<ReturndataDecoding[]> {
    return await this.contractDecoder.decodeReturnValueWithAdditionalContexts(
      abi,
      data,
      options,
      this.additionalContexts
    );
  }

  /**
   * See [[ProjectDecoder.abifyCalldataDecoding]].
   */
  public abifyCalldataDecoding(decoding: CalldataDecoding): CalldataDecoding {
    return this.projectDecoder.abifyCalldataDecoding(decoding);
  }

  /**
   * See [[ProjectDecoder.abifyLogDecoding]].
   */
  public abifyLogDecoding(decoding: LogDecoding): LogDecoding {
    return this.projectDecoder.abifyLogDecoding(decoding);
  }

  /**
   * See [[ProjectDecoder.abifyReturndataDecoding]].
   */
  public abifyReturndataDecoding(
    decoding: ReturndataDecoding
  ): ReturndataDecoding {
    return this.projectDecoder.abifyReturndataDecoding(decoding);
  }

  /**
   * **This method is asynchronous.**
   *
   * This mostly behaves as [[ProjectDecoder.events]].
   * However, unlike other variants of this function, this one, by default, restricts to events originating from this instance's address.
   * If you don't want to restrict like that, you can explicitly use `address: undefined` in the options to disable this.
   * (You can also of course set a different address to restrict to that.)
   * @param options Used to determine what events to fetch; see the documentation on the [[EventOptions]] type for more.
   */
  public async events(
    options: DecoderTypes.EventOptions = {}
  ): Promise<DecoderTypes.DecodedLog[]> {
    return await this.projectDecoder.eventsWithAdditionalContexts(
      { address: this.contractAddress, ...options },
      this.additionalContexts
    );
  }

  //in addition to returning the slot we want, it also returns a Type
  //used in the recursive call
  //HOW TO USE:
  //variable may be a variable id (number or numeric string) or name (string) or qualified name (also string)
  //struct members are given by name (string)
  //array indices and numeric mapping keys may be BN, number, or numeric string
  //string mapping keys should be given as strings. duh.
  //bytes mapping keys should be given as hex strings beginning with "0x"
  //address mapping keys are like bytes; checksum case is not required
  //boolean mapping keys may be given either as booleans, or as string "true" or "false"
  private async constructSlot(
    variable: number | string,
    ...indices: any[]
  ): Promise<{ slot?: Storage.Slot; type?: Format.Types.Type }> {
    //base case: we need to locate the variable and its definition
    if (indices.length === 0) {
      let allocation = this.findVariableByNameOrId(variable);
      if (!allocation) {
        throw new VariableNotFoundError(variable);
      }

      let dataType = Ast.Import.definitionToType(
        allocation.definition,
        this.compilation.id,
        this.contract.compiler,
        "storage"
      );
      let pointer = allocation.pointer;
      if (pointer.location !== "storage") {
        //i.e., if it's a constant
        return { slot: undefined, type: undefined };
      }
      return { slot: pointer.range.from.slot, type: dataType };
    }

    //main case
    let parentIndices = indices.slice(0, -1); //remove last index
    let { slot: parentSlot, type: parentType } = await this.constructSlot(
      variable,
      ...parentIndices
    );
    if (parentSlot === undefined) {
      return { slot: undefined, type: undefined };
    }
    let rawIndex = indices[indices.length - 1];
    let index: any;
    let key: Format.Values.ElementaryValue;
    let slot: Storage.Slot;
    let dataType: Format.Types.Type;
    switch (parentType.typeClass) {
      case "array":
        if (rawIndex instanceof BN) {
          index = rawIndex.clone();
        } else {
          index = new BN(rawIndex);
        }
        dataType = parentType.baseType;
        let size = Storage.Allocate.storageSize(
          dataType,
          this.userDefinedTypes,
          this.allocations.storage
        );
        if (!Storage.Utils.isWordsLength(size)) {
          return { slot: undefined, type: undefined };
        }
        slot = {
          path: parentSlot,
          offset: index.muln(size.words),
          hashPath: parentType.kind === "dynamic"
        };
        break;
      case "mapping":
        let keyType = parentType.keyType;
        if (
          keyType.typeClass === "enum" ||
          keyType.typeClass === "userDefinedValueType"
        ) {
          keyType = <Format.Types.EnumType>(
            Format.Types.fullType(keyType, this.userDefinedTypes)
          );
        }
        key = Utils.wrapElementaryValue(rawIndex, keyType);
        dataType = parentType.valueType;
        slot = {
          path: parentSlot,
          key,
          offset: new BN(0)
        };
        break;
      case "struct":
        //NOTE: due to the reliance on storage allocations,
        //we don't need to use fullType or what have you
        let allocation: Storage.Allocate.StorageMemberAllocation =
          this.allocations.storage[parentType.id].members.find(
            ({ name }) => name === rawIndex
          ); //there should be exactly one
        if (!allocation) {
          throw new MemberNotFoundError(
            rawIndex,
            parentType,
            variable,
            indices
          );
        }
        slot = {
          path: parentSlot,
          //need type coercion here -- we know structs don't contain constants but the compiler doesn't
          offset: allocation.pointer.range.from.slot.offset.clone()
        };
        dataType = allocation.type;
        break;
      default:
        return { slot: undefined, type: undefined };
    }
    return { slot, type: dataType };
  }
}
