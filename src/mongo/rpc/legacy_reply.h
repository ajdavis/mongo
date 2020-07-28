/**
 *    Copyright (C) 2018-present MongoDB, Inc.
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

#include "mongo/db/dbmessage.h"
#include "mongo/db/jsobj.h"
#include "mongo/rpc/protocol.h"
#include "mongo/rpc/reply_interface.h"

namespace mongo {
class Message;

namespace rpc {

/**
 * Immutable view of an OP_REPLY legacy-style command reply.
 */
class LegacyReply final : public ReplyInterface {
public:
    /**
     * Construct a Reply from a Message.
     * The underlying message MUST outlive the Reply.
     */
    explicit LegacyReply(const Message* message);

    /**
     * The result of executing the command.
     */
    const BSONObj& getCommandReply() const final;

    /**
     * TODO
     */
    virtual int32_t getMessageId() const {
        return _messageId;
    }

    /**
     * TODO
     */
    virtual int32_t getResponseTo() const {
        return _responseTo;
    }

    Protocol getProtocol() const final;

private:
    BSONObj _commandReply;
    int32_t _messageId;
    int32_t _responseTo;
};

}  // namespace rpc
}  // namespace mongo
