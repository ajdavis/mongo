/**
 *    Copyright (C) 2020-present MongoDB, Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the Server Side Public License, version 1,
 *    as published by MongoDB, Inc.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    Server Side Public License for more details.
 *
 *    You should have received a copy of the Server Side Public License
 *    along with this program. If not, see
 *    <http://www.mongodb.com/licensing/server-side-public-license>.
 *
 *    As a special exception, the copyright holders give permission to link the
 *    code of portions of this program with the OpenSSL library under certain
 *    conditions as described in each individual source file and distribute
 *    linked combinations including the program with the OpenSSL library. You
 *    must comply with the Server Side Public License in all respects for
 *    all of the code used other than as permitted herein. If you modify file(s)
 *    with this exception, you may extend this exception to your version of the
 *    file(s), but you are not obligated to do so. If you do not wish to do so,
 *    delete this exception statement from your version. If you delete this
 *    exception statement from all source files in the program, then also delete
 *    it in the license file.
 */

#pragma once

#include <unordered_map>

#include "mongo/client/query.h"
#include "mongo/db/logical_time.h"
#include "mongo/db/service_context.h"
#include "mongo/platform/mutex.h"
#include "mongo/transport/session.h"

/* Test-only vector clock. Unlike the vector clock we use in production, this is a traditional
 * vector clock whose components are servers. The clock advances whenever a message is sent or
 * received, but not when data is written. This is useful for establishing causation of intracluster
 * messages and state changes, e.g. for visualization with ShiViz. */

namespace mongo {

class NodeVectorClock {
public:
    static NodeVectorClock* get(ServiceContext* context);

    NodeVectorClock();
    virtual ~NodeVectorClock();

    /**
     * Initialize this server's vector clock entry when loading a replica set config.
     */
    void setMyHostAndPort(HostAndPort hostAndPort);

    /**
     * Uninitialize this server's entry when loading a replica set config that omits self. We can
     * still send and receive other servers' entries.
     */
    void clearMyHostAndPort();

    /**
     * Returns an instantaneous snapshot of the current vector clock.
     */
    BSONObj getClock();

    /**
     * Append the node vector clock to outMessage (a request or reply) to send to another server.
     */
    void gossipOut(BSONObjBuilder* outMessage);

    /**
     * Read the node vector clock from another server's request or reply.
     */
    void gossipIn(const BSONObj& inMessage);

private:
    BSONObj _getClock(WithLock lk);

    mutable Mutex _mutex = MONGO_MAKE_LATCH("NodeVectorClock::_mutex");
    ServiceContext* _service{nullptr};
    long long _myClock = 1LL;
    HostAndPort _myHostAndPort;
    std::unordered_map<std::string, long long> _clock;
    static constexpr char kNodeVectorClockFieldName[] = "nodeVectorClockForTest";
};

}  // namespace mongo
