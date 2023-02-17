/**
  Manage plug and play connection status to Ambianic Edge.
*/
import {
  PEER_NEW_INSTANCE,
  PEER_DISCONNECTED,
  PEER_CONNECTING,
  PEER_DISCONNECTING,
  PEER_DISCOVERING,
  PEER_DISCOVERING_CANCELLED,
  PEER_DISCOVERING_ERROR,
  PEER_DISCOVERING_OFF,
  PEER_DISCOVERING_DONE,
  PEER_AUTHENTICATING,
  PEER_CONNECTED,
  PEER_CONNECTION_ERROR,
  PNP_SERVICE_DISCONNECTED,
  PNP_SERVICE_CONNECTING,
  PNP_SERVICE_CONNECTED,
  USER_MESSAGE,
  NEW_PEER_ID,
  NEW_REMOTE_PEER_ID,
  REMOTE_PEER_ID_REMOVED,
  PEER_FETCH,
  EDGE_API
} from './mutation-types.js'
import {
  INITIALIZE_PNP,
  PNP_SERVICE_CONNECT,
  PNP_SERVICE_RECONNECT,
  PEER_DISCOVER,
  PEER_CONNECT,
  PEER_DISCONNECT,
  PEER_AUTHENTICATE,
  REMOVE_REMOTE_PEER_ID,
  CHANGE_REMOTE_PEER_ID,
  HANDLE_PEER_CONNECTION_ERROR
} from './action-types.js'
import { ambianicConf } from '@/config'
import Peer from 'peerjs'
import { PeerRoom } from '@/remote/peer-room'
import { PeerFetch } from '@/remote/peer-fetch'
import { EdgeAPI } from '@/remote/edgeAPI'
export const STORAGE_KEY = 'ambianic-pnp-settings'

const state = {
  /**
    Reference to the PeerJS instance active
    in the current global application scope (i.e. window scope).
  */
  peer: undefined, // peerjs.Peer object local to the current browser window/tab session
  /**
   * Reference to the ID of the PeerJS instance active
   * in the current application (browser tab).
   *
   * It is not persisted in order to allow multiple browser tabs to access the PWA
   * simultaneously.
   *
  */
  myPeerId: undefined,
  /**
    Reference to the ID of the remote PeerJS instance
    as registered with the PnP service.
  */
  remotePeerId: window.localStorage.getItem(`${STORAGE_KEY}.remotePeerId`),
  /**
    Helper reference to the ID of the PeerJS instance active
    in the current application.
  */
  lastPeerId: undefined,
  /**
   * Status of LAN peer discovery cycle
   */
  discoveryStatus: PEER_DISCOVERING_OFF,
  /**
   * Remote peers that were discovered on the local network
   */
  discoveredPeers: [],
  /**
    Connection status message for user to see
  */
  userMessage: '',
  /**
    Connection to the remote Ambianic Edge device
  */
  peerConnection: undefined,
  /**
    Status of current peer connection to remote peer
  */
  peerConnectionStatus: PEER_DISCONNECTED,
  /**
    Status of current peer connection to remote pnp service
  */
  pnpServiceConnectionStatus: PNP_SERVICE_DISCONNECTED,
  /**
    PeerFetch instance
  */
  peerFetch: undefined,
  /**
    EdgeAPI instance
  */
  edgeAPI: undefined,
  /**
   * discoveryLoopPause is the duration in milliseconds to pause between pair discovery retries
   */
  discoveryLoopPause: 3000,
  /**
   * peerConnectLoopPause is the duration in milliseconds to pause between peer connect retries
   */
  peerConnectLoopPause: 500,
  /**
   * peerConnectOfferTimeout is the duration in milliseconds for a remote peer connection offer to expire
   */
  peerConnectOfferTimeout: 15000
}

const mutations = {
  [PEER_NEW_INSTANCE] (state, peer) {
    state.peer = peer
  },
  [PEER_DISCONNECTED] (state) {
    state.peerConnection = undefined
    state.peerConnectionStatus = PEER_DISCONNECTED
    state.peerFetch = undefined
    state.edgeAPI = undefined
  },
  [PEER_DISCOVERING_DONE] (state, remotePeerIds) {
    state.discoveryStatus = PEER_DISCOVERING_DONE
    state.discoveredPeers = remotePeerIds
    console.debug('Discovered Peer IDs:', state.discoveredPeers)
  },
  [PEER_DISCOVERING] (state) {
    state.discoveryStatus = PEER_DISCOVERING
    state.discoveredPeers = []
  },
  [PEER_DISCOVERING_CANCELLED] (state) {
    state.discoveryStatus = PEER_DISCOVERING_CANCELLED
  },
  [PEER_DISCOVERING_ERROR] (state) {
    state.discoveryStatus = PEER_DISCOVERING_ERROR
  },
  [PEER_DISCOVERING_OFF] (state) {
    state.discoveryStatus = PEER_DISCOVERING_OFF
  },
  [PEER_CONNECTING] (state) {
    state.peerConnectionStatus = PEER_CONNECTING
  },
  [PEER_DISCONNECTING] (state) {
    state.peerConnectionStatus = PEER_DISCONNECTING
  },
  [PEER_AUTHENTICATING] (state) {
    state.peerConnectionStatus = PEER_AUTHENTICATING
  },
  [PEER_CONNECTED] (state, peerConnection) {
    state.peerConnection = peerConnection
    state.peerConnectionStatus = PEER_CONNECTED
  },
  [PEER_CONNECTION_ERROR] (state) {
    state.peerConnectionStatus = PEER_CONNECTION_ERROR
  },
  [PNP_SERVICE_DISCONNECTED] (state) {
    state.pnpServiceConnectionStatus = PNP_SERVICE_DISCONNECTED
  },
  [PNP_SERVICE_CONNECTING] (state) {
    state.pnpServiceConnectionStatus = PNP_SERVICE_CONNECTING
  },
  [PNP_SERVICE_CONNECTED] (state) {
    state.pnpServiceConnectionStatus = PNP_SERVICE_CONNECTED
  },
  [USER_MESSAGE] (state, newUserMessage) {
    state.userMessage = newUserMessage
  },
  [NEW_PEER_ID] (state, newPeerId) {
    state.myPeerId = newPeerId
  },
  [NEW_REMOTE_PEER_ID] (state, newRemotePeerId) {
    console.debug('NEW_REMOTE_PEER_ID: Setting state.remotePeerId to : ', newRemotePeerId)
    state.remotePeerId = newRemotePeerId
    window.localStorage.setItem(`${STORAGE_KEY}.remotePeerId`, newRemotePeerId)
  },
  [REMOTE_PEER_ID_REMOVED] (state) {
    console.debug('REMOTE_PEER_ID_REMOVED: Removing remote Peer Id from local connection storage.')
    state.remotePeerId = undefined
    window.localStorage.removeItem(`${STORAGE_KEY}.remotePeerId`)
  },
  [PEER_FETCH] (state, peerFetch) {
    console.debug('PEER_FETCH: Setting PeerFetch instance.')
    state.peerFetch = peerFetch
  },
  [EDGE_API] (state, edgeAPI) {
    console.debug('EDGE_API: Setting EdgeAPI instance.')
    state.edgeAPI = edgeAPI
  }
}

/**
  Try to discover peers in the same signaling server room.
  This usually relates to peers on the same local wifi.
*/
async function discoverRemotePeerIds ({ state, commit }) {
  const peer = state.peer
  console.debug('discoverRemotePeerIds() start')
  // first try to find the remote peer ID in the same room
  console.debug({ peer })
  const myRoom = new PeerRoom(peer)
  console.debug('Fetching room members')
  const roomMembers = await myRoom.getRoomMembers()
  console.debug('Fetched roomMembers', roomMembers)
  const peerIds = roomMembers.clientsIds
  console.debug('myRoom members', peerIds)
  console.debug('typeof peerIds', typeof peerIds)
  // find all peerIds that are different than this PWA peer ID
  var remotePeerIds = peerIds.filter(pid => pid !== state.myPeerId)
  console.debug(`remotePeerIds: ${remotePeerIds} found among myRoom members: ${peerIds}`)
  if (remotePeerIds.length > 0) {
    return remotePeerIds
  } else {
    // unable to auto discover
    // ask user for help
    commit(USER_MESSAGE,
      `Still looking.
        Please make sure you are on the same local network
        as the Ambianic Edge device.
      `)
  }
}

function setPnPServiceConnectionHandlers (
  { state, commit, dispatch }) {
  const peer = state.peer
  peer.on('open', function (id) {
    commit(PNP_SERVICE_CONNECTED)
    // Workaround for peer.reconnect deleting previous id
    if (!peer.id) {
      console.log('pnp client: Received null id from peer open')
      peer.id = state.myPeerId
    } else {
      if (state.myPeerId !== peer.id) {
        console.log(
          'pnp client: Service returned new peerId. Old, New',
          state.myPeerId,
          peer.id
        )
        commit(NEW_PEER_ID, peer.id)
      }
    }
    console.log('pnp client: myPeerId: ', peer.id)
    // signaling server connection established
  })
  peer.on('disconnected', function () {
    commit(PNP_SERVICE_DISCONNECTED)
    commit(USER_MESSAGE, 'Disconnected. Please check your internet connection.')
    console.log('pnp client: Disconnected from signaling server. Will try to reconnect.')
    setTimeout(() => { // give the network a few moments to recover
      dispatch(PNP_SERVICE_CONNECT)
    }, 3000)
  })
  peer.on('close', function () {
    commit(PNP_SERVICE_DISCONNECTED)
    commit(USER_MESSAGE, 'Signaling server closed connection. Will try to reconnect.')
    console.log('Connection to PnP server closed. Will try to reconnect.')
    setTimeout(() => { // give the network a few moments to recover
      dispatch(PNP_SERVICE_CONNECT)
    }, 3000)
  })
  peer.on('error', function (err) {
    console.log('PnP service connection error', err)
    commit(USER_MESSAGE,
      `
      Error while connecting. Will retry shortly. Is your Internet connection OK?
      `)
    commit(PNP_SERVICE_DISCONNECTED)
    commit(PEER_DISCONNECTED)
    console.log('pnp service connection error', { err })
    console.log('Will try to reconnect to PnP server...')
    // retry peer connection in a few seconds
    setTimeout(() => { // give the network a few moments to recover
      dispatch(PNP_SERVICE_CONNECT)
    }, 3000)
  })
  // remote peer is trying to initiate a connection
  peer.on('connection', function (peerConnection) {
    console.debug('#####>>>>> remote peer trying to establish connection')
    setPeerConnectionHandlers({ state, commit, dispatch, peerConnection })
    commit(PEER_CONNECTING)
  })
}

function setPeerConnectionHandlers ({
  state,
  commit,
  dispatch,
  peerConnection,
  peerConnectOfferTimer
}) {
  // setup connection progress callbacks
  peerConnection.on('open', function () {
    clearTimeout(peerConnectOfferTimer)
    const peerFetch = new PeerFetch(peerConnection)
    console.debug('Peer DataConnection is now open. Creating PeerFetch wrapper.')
    commit(PEER_FETCH, peerFetch)
    // schedule an async PEER_AUTHENTICATE step
    // There is 1 second delay to allow the RTCDataChannel to prepare
    // Without the delay, sometimes the datachannel "jams"
    setTimeout(() => dispatch(PEER_AUTHENTICATE, peerConnection), 1000)
  })

  peerConnection.on('close', function () {
    clearTimeout(peerConnectOfferTimer)
    commit(PEER_DISCONNECTED)
    commit(USER_MESSAGE, 'Connection to remote peer closed')
    console.debug('#########>>>>>>>>> p2p connection closed')
  })

  peerConnection.on('error', function (err) {
    clearTimeout(peerConnectOfferTimer)
    const errMsg = `Error in connection to remote peer ID: ${peerConnection.peer}`
    console.info(errMsg, { err })
    // schedule an async HANDLE_PEER_CONNECTION_ERROR action
    dispatch(HANDLE_PEER_CONNECTION_ERROR, { peerConnection, errMsg })
  })

  console.debug('peerConnection.on(event) handlers all set.')
}

const actions = {
  /**
  * Initialize PnP Service and Peer Connection
  */
  async [INITIALIZE_PNP] ({ state, commit, dispatch }) {
    // clear reference to any pre-existing and potentially corrupt peer instance
    // in order to force a new peer instance creation
    state.peer = undefined
    await dispatch(PNP_SERVICE_CONNECT)
  },
  /**
  * Establish connection to PnP Service and
  * create the Peer object for our end of the connection.
  *
  * Set up callbacks to handle any events related to our
  * peer object.
  */
  async [PNP_SERVICE_CONNECT] ({ state, commit, dispatch }) {
    const peer = state.peer
    // if connection to pnp service already open, then nothing to do
    if (peer && peer.open) { return }
    // if in the middle of pnp server connection cycle, skip
    if (state.pnpServiceConnectionStatus === PNP_SERVICE_CONNECTING) { return }
    // if peer exists but not connected then try to reuse it and just reconnect
    if (peer) {
      await dispatch(PNP_SERVICE_RECONNECT)
    } else {
      // Otherwise create a new peer object with connection to shared PeerJS server
      console.log('pnp client: creating peer')
      // If we already have an assigned peerId, we will reuse it forever.
      // We expect that peerId is crypto secure. No need to replace.
      // Unless the user explicitly requests a refresh.
      console.log('pnp client: last saved myPeerId', state.myPeerId)
      const newPeer = new Peer(state.myPeerId,
        {
          host: ambianicConf.AMBIANIC_PNP_HOST,
          port: ambianicConf.AMBIANIC_PNP_PORT,
          secure: ambianicConf.AMBIANIC_PNP_SECURE,
          config: ambianicConf.ICE_CONFIG,
          debug: 3
        }
      )
      commit(PEER_NEW_INSTANCE, newPeer)
      console.log('pnp client: peer created')
      setPnPServiceConnectionHandlers({ state, commit, dispatch })
      commit(PNP_SERVICE_CONNECTING)
    }
  },
  /**
  * Establish connection to PnP Service and
  * create the Peer object for our end of the connection.
  *
  * Set up callbacks to handle any events related to our
  * peer object.
  */
  async [PNP_SERVICE_RECONNECT] ({ state, commit, dispatch }) {
    const peer = state.peer
    // if connection to pnp service already open, then nothing to do
    if (peer.open) return
    // if in the middle of pnp server connection cycle, skip
    if (state.pnpServiceConnectionStatus === PNP_SERVICE_CONNECTING) { return }
    console.log('pnp client: reconnecting peer...')
    // Workaround for peer.reconnect deleting previous id
    if (!peer.id) {
      console.log('BUG WORKAROUND: Peer lost ID. Resetting to last known ID.')
      peer._id = state.myPeerId
    }
    peer._lastServerId = state.myPeerId
    commit(PNP_SERVICE_CONNECTING)
    peer.reconnect()
  },
  /**
  * Find remotePeerId for Ambianic Edge device to pair with.
  *
  */
  async [PEER_DISCOVER] ({ state, commit, dispatch }) {
    commit(PEER_DISCOVERING)
    const discoveryLoop = async () => {
      // start a discovery loop
      console.log('Discovering remote peer...')
      // its possible that the PNP signaling server connection was disrupted
      // while looping in peer discovery mode
      if (state.pnpServiceConnectionStatus !== PNP_SERVICE_CONNECTED) {
        console.debug('PNP Service disconnected. Reconnecting...')
        await dispatch(PNP_SERVICE_CONNECT)
      }
      try {
        if (state.pnpServiceConnectionStatus === PNP_SERVICE_CONNECTED) {
          console.debug('discovering peers on the local network...')
          const remotePeerIds = await discoverRemotePeerIds({ state, commit })
          // Signal to state watchers that we have discovered peers.
          // Let user inspect discovered peer IDs and decide how to proceed.
          // Similar UX to local WiFi and Bluetooth device discovery.
          commit(PEER_DISCOVERING_DONE, remotePeerIds)
        } else {
          // signaling server connection is still not ready, skip this cycle
          // and wait for the next scheduled retry
          console.debug('PNP signaling server still not connected. Will retry shortly.')
          setTimeout(discoveryLoop, state.discoveryLoopPause)
        }
      } catch (err) {
        console.warn('Error while looking for remote peer. Will retry shortly.',
          err)
        commit(PEER_DISCOVERING_ERROR)
        commit(USER_MESSAGE, 'Error while discovering peers on local WiFi.')
      }
    }
    await discoveryLoop()
  },
  /**
  * Create the connection between the two Peers.
  *
  * Set up callbacks to handle any events related to the
  * direct peer-to-peer connection and data received on it.
  */
  async [PEER_CONNECT] ({ state, commit, dispatch }, remotePeerId) {
    // if already connected or in the process of connecting to remote peer, then stop.
    if (state.peerConnectionStatus === PEER_CONNECTING ||
      state.peerConnectionStatus === PEER_CONNECTED) {
      console.log('Peer connection already in progress. Aborting peer connect loop.',
        state.peerConnectionStatus)
      // avoid redundant connect looping
      // in case of multiple connection errors
      return
    }
    console.debug('#####>>>>>>> Connecting to remote peer', { remotePeerId })
    if (state.peerConnection) {
      // make sure any previous connection is closed and cleaned up
      console.info('>>>>>>> Closing and cleaning up existing peer connection.', { remotePeerId })
      await state.peerConnection.close()
    }
    const peerConnectLoop = async () => {
      console.log('Entering peer connect loop...')
      // Its possible that the PNP signaling server connection was disrupted
      // We need an active connection to the signaling server
      // in order to negotiate a p2p connection with the remote peer.
      if (state.pnpServiceConnectionStatus !== PNP_SERVICE_CONNECTED) {
        console.debug('PNP Service disconnected. Reconnecting...')
        await dispatch(PNP_SERVICE_CONNECT)
        console.debug('PNP Service still not connected. Will retry peer connection shortly.')
        // check again in a little bit if the signaling connection is ready
        // and if so, proceed to p2p handshake
        setTimeout(peerConnectLoop, state.peerConnectLoopPause)
      } else {
        // Signaling server is connected, let's proceed to p2p handshake
        console.debug(`#####>>>> PNP Service connection status: ${state.pnpServiceConnectionStatus}`)
        console.info('>>>>>> Opening new peer connection.')
        const peer = state.peer
        commit(PEER_CONNECTING)
        const peerConnection = peer.connect(remotePeerId, {
          label: 'http-proxy', reliable: true, serialization: 'raw'
        })
        const handlePeerConnectOfferTimeout = async function () {
          if (state.peerConnection) {
            // In case a connection object was created in the connection OFFER process
            // make sure to close and cleaned it up.
            console.info('Peer connection OFFER expired. Closing and cleaning up peer connection object.', { remotePeerId })
            await state.peerConnection.close()
          }
          const errMsg = 'Peer connection attempt failed. Is the remote device online?'
          await dispatch(HANDLE_PEER_CONNECTION_ERROR, { peerConnection, errMsg })
        }
        const peerConnectOfferTimer = setTimeout(handlePeerConnectOfferTimeout, state.peerConnectOfferTimeout)
        setPeerConnectionHandlers({
          state,
          commit,
          dispatch,
          peerConnection,
          peerConnectOfferTimer
        })
      }
    }
    // begin peer connection sequence
    await peerConnectLoop()
  },
  /**
  * Authenticate remote peer. Make sure its a genuine Ambianic Edge device.
  *
  */
  async [PEER_AUTHENTICATE] (context, peerConnection) {
    const { state, commit, dispatch } = context
    commit(PEER_AUTHENTICATING)
    commit(USER_MESSAGE, `Authenticating remote peer: ${peerConnection.peer}`)
    console.debug('Authenticating remote Peer ID: ', peerConnection.peer)
    let authPassed = false
    try {
      console.debug('PEER_AUTHENTICATE start')
      console.debug('PEER_AUTHENTICATE instantiating EdgeAPI with context:', context)
      const edgeAPI = new EdgeAPI(context)
      commit(EDGE_API, edgeAPI)
      console.debug('PEER_AUTHENTICATE calling EdgeAPI.auth()')
      const response = await state.edgeAPI.auth()
      console.debug('PEER_AUTHENTICATE API called')
      if (response && response.header && response.header.status === 200) {
        console.debug('PEER_AUTHENTICATE status OK')
        console.debug(`PEER_AUTHENTICATE response.content: ${response.content}`)
        const text = state.peerFetch.textDecode(response.content)
        console.debug(`PEER_AUTHENTICATE response.content decoded: ${response.content}`)
        // if data is authentication challenge response, verify it
        // for now we naively check for Ambianic in the response.
        authPassed = text.includes('Ambianic')
        console.debug('PEER_AUTHENTICATE response body OK', { authPassed })
      } else {
        console.error('PEER_AUTHENTICATE unexpended auth response.', { response })
      }
    } catch (err) {
      console.warn(`PEER_AUTHENTICATE action. Error while connecting to remote peer ID: ${peerConnection.peer}`, err)
    }
    if (authPassed) {
      // console.debug('Remote peer authenticated as:', authMessage.name)
      commit(PEER_CONNECTED, peerConnection)
      // remote Peer ID authenticated,
      // lets store it for future (re)connections
      // if its not already stored
      if (state.remotePeerId !== peerConnection.peer) {
        commit(NEW_REMOTE_PEER_ID, peerConnection.peer)
      }
    } else {
      const errMsg = 'Remote peer authentication failed.'
      console.warn(errMsg)
      await dispatch(HANDLE_PEER_CONNECTION_ERROR, { peerConnection, errMsg })
    }
    console.debug('DataChannel transport capabilities',
      peerConnection.dataChannel)
  },
  /**
   * @param {*} remotePeerId The Ambianic Edge PeerJS ID
   * that the Ambianic UI will pair with.
   *
   * Update Ambianic Edge Peer ID for the remote Ambianic Edge you want to pair with.
   * Perhaps your parents are isolated, then it would be nice to connect to
   * them or let them connect to you.
   */
  async [CHANGE_REMOTE_PEER_ID] ({ state, commit, dispatch }, remotePeerId) {
    await dispatch(REMOVE_REMOTE_PEER_ID)
    commit(NEW_REMOTE_PEER_ID, remotePeerId)
    await dispatch(PEER_CONNECT, remotePeerId)
  },
  /**
  * Disconnect from remote peer id.
  */
  async [PEER_DISCONNECT] ({ state, commit, dispatch }) {
    if (state.peerConnectionStatus !== PEER_DISCONNECTED) {
      commit(PEER_DISCONNECTING)
      const conn = state.peerConnection
      if (conn) {
        try {
          console.debug('Closing Peer DataConnection.', { conn })
          await conn.close()
        } catch (err) {
          console.info('Error while closing peer DataConnection.', err)
        }
      }
      commit(PEER_DISCONNECTED)
    }
  },
  /**
  * Disconnect and Remove remote peer id from local store.
  */
  async [REMOVE_REMOTE_PEER_ID] ({ state, commit, dispatch }) {
    await dispatch(PEER_DISCONNECT)
    commit(REMOTE_PEER_ID_REMOVED)
  },
  async [HANDLE_PEER_CONNECTION_ERROR] ({ state, commit, dispatch }, { peerConnection, errMsg }) {
    console.info('######>>>>>>> p2p connection error', errMsg)
    console.info('Error while connecting to remote peer ID:', peerConnection.peer)
    commit(USER_MESSAGE, errMsg)
    commit(PEER_CONNECTION_ERROR)
  }
}

const getters = {
  isEdgeConnected: state => {
    return state.peerConnectionStatus === PEER_CONNECTED
  }
}

export const pnpStoreModule = {
  state,
  getters,
  mutations,
  actions
}
