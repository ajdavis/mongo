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

#define MONGO_LOGV2_DEFAULT_COMPONENT ::mongo::logv2::LogComponent::kNodeVectorClock

#include "mongo/platform/basic.h"

#include "mongo/db/node_vector_clock.h"

#include "mongo/db/repl/replication_coordinator.h"
#include "mongo/db/service_context.h"
#include "mongo/logv2/log.h"

namespace mongo {

const ServiceContext::Decoration<NodeVectorClock> forService =
    ServiceContext::declareDecoration<NodeVectorClock>();

NodeVectorClock* NodeVectorClock::get(ServiceContext* context) {
    return &forService(context);
}

NodeVectorClock::NodeVectorClock() = default;

NodeVectorClock::~NodeVectorClock() = default;

void NodeVectorClock::setMyHostAndPort(HostAndPort hostAndPort) {
    stdx::lock_guard<Latch> lock(_mutex);
    _myHostAndPort = hostAndPort;
}

void NodeVectorClock::clearMyHostAndPort() {
    stdx::lock_guard<Latch> lock(_mutex);
    _myHostAndPort = {};
}

BSONObj NodeVectorClock::getClock() {
    stdx::lock_guard<Latch> lock(_mutex);
    return _getClock(lock);
}

void NodeVectorClock::gossipOut(BSONObjBuilder* outMessage) {
    auto replCoord = repl::ReplicationCoordinator::get(getGlobalServiceContext());
    if (!replCoord) {
        return;
    }

    BSONObj clockObj;

    {
        stdx::lock_guard<Latch> lock(_mutex);
        if (_myHostAndPort.host().empty()) {
            return;
        }

        _myClock++;
        _clock[_myHostAndPort.toString()] = _myClock;

        clockObj = _getClock(lock);
    }

    LOGV2(202007190,
          "Sending node vector clock",
          "nodeVectorClock"_attr = clockObj,
          "self"_attr = _myHostAndPort.toString(),
          "message"_attr = outMessage->asTempObj());

    outMessage->append(kNodeVectorClockFieldName, clockObj);
}

void NodeVectorClock::gossipIn(const BSONObj& inMessage) {
    auto inClock = inMessage[kNodeVectorClockFieldName];
    if (inClock.eoo()) {
        return;
    }

    uassert(0,
            str::stream() << "Wrong type for " << kNodeVectorClockFieldName << ": "
                          << typeName(inClock.type()),
            inClock.isABSONObj());

    stdx::lock_guard<Latch> lock(_mutex);
    if (_myHostAndPort.host().empty()) {
        return;
    }

    _myClock++;

    for (auto& elem : inClock.Obj()) {
        uassert(0,
                str::stream() << "Wrong type for " << kNodeVectorClockFieldName
                              << " element: " << typeName(elem.type()),
                elem.isNumber());
        _clock[elem.fieldName()] = std::max(_clock[elem.fieldName()], elem.numberLong());
    }

    LOGV2(202007191,
          "My node vector clock after receiving message",
          "self"_attr = _myHostAndPort.toString(),
          "nodeVectorClock"_attr = _getClock(lock));
}

BSONObj NodeVectorClock::_getClock(WithLock lk) {
    BSONObjBuilder bob;
    for (auto& [hostString, hostClock] : _clock) {
        bob.append(hostString, hostClock);
    }

    return bob.obj();
}
}  // namespace mongo
