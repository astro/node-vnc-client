var util = require('util');
var net = require('net');
var crypto = require('crypto');

const STATE_HANDSHAKE = 0,
    STATE_AUTH = 1,
    STATE_AUTH_VNC = 2,
    STATE_AUTH_RES = 3,
    STATE_INIT = 4,
    STATE_MSG = 5,
    STATE_RECTANGLES = 6;

const MSG_FRAMEBUFFER_UPDATE = 0;

const ENCODING_RAW = 0,
    ENCODING_COPY_RECT = 1;


function parsePixelFormat(buf) {
    return {
	bpp: buf.readUInt8(0),
	depth: buf.readUInt8(1),
	bigEndian: buf.readUInt8(2),
	trueColor: buf.readUInt8(3),
	rMax: buf.readUInt16BE(4),
	gMax: buf.readUInt16BE(6),
	bMax: buf.readUInt16BE(8),
	rShift: buf.readUInt8(10),
	gShift: buf.readUInt8(11),
	bShift: buf.readUInt8(12)
    };
}


function VNCClient(host, port, password) {
    this.password = password;
    this.socket = net.createConnection(port, host);
    this.recvBuf = new Buffer(0);
    this.socket.on('connect', this.onConnect.bind(this));
    this.socket.on('data', this.onData.bind(this));
    this.socket.on('close', this.onClose.bind(this));
}
util.inherits(VNCClient, process.EventEmitter);
exports.VNCClient = VNCClient;

VNCClient.prototype.onConnect = function() {
    this.state = STATE_HANDSHAKE;
};

VNCClient.prototype.onClose = function() {
    console.warn("RFB connection closed");
};

VNCClient.prototype.onData = function(data) {
    if (data) {
	var recvBuf = new Buffer(this.recvBuf.length + data.length);
	this.recvBuf.copy(recvBuf);
	data.copy(recvBuf, this.recvBuf.length);
	this.recvBuf = recvBuf;
    }

    //console.log("data", this.state, data, this.recvBuf);

    switch(this.state) {
    case STATE_HANDSHAKE:
	if (this.recvBuf.length >= 12) {
	    var s = this.recvBuf.slice(0, 12).toString();
	    this.recvBuf = this.recvBuf.slice(12);
	    var m;
	    if ((m = s.match(/^RFB (\d\d\d)\.(\d\d\d)/))) {
		var maj = parseInt(m[1], 10);
		var min = parseInt(m[2], 10);
		console.log("Server speaks "+maj+"."+min);
		if (maj >= 3 && min >= 7) {
		    this.version = [maj, min];
		    this.socket.write("RFB 003.007\n");
		    this.state = STATE_AUTH;
		} else {
		    this.emit('error', new Error("Protocol version "+maj+"."+min+" not implemented"));
		}
	    } else {
		this.emit('error', new Error("Invalid protocol handshake"));
	    }
	}
	break;
    case STATE_AUTH:
	if (this.recvBuf.length > 0 &&
	    this.recvBuf.length >= this.recvBuf[0] + 1) {

	    var secTypes = this.recvBuf.slice(1, this.recvBuf[0] + 1);
	    this.recvBuf = this.recvBuf.slice(this.recvBuf[0] + 1);

	    var noAuth = false, vncAuth = false;
	    for(var i = 0; i < secTypes.length; i++) {
		switch(secTypes[i]) {
		    case 1:
			noAuth = true;
			break;
		    case 2:
			vncAuth = true;
			break;
		}
	    }
	    if (noAuth) {
		this.socket.write(new Buffer([1]));
		this.socket.write(new Buffer([1]));
		this.state = STATE_INIT;
	    } else if (vncAuth) {
		this.socket.write(new Buffer([2]));
		this.state = STATE_AUTH_VNC;
	    } else {
		this.emit('error', new Error("VNC Authentication not offered"));
	    }
	}
	break;
    case STATE_AUTH_VNC:
	if (this.recvBuf.length >= 16) {
	    var challenge = this.recvBuf.slice(0, 16);
	    this.recvBuf = this.recvBuf.slice(16);

	    var des = crypto.createCipher('des', this.password);
	    var response = des.update(challenge, 'binary', 'base64');
	    response += des.final('base64');
	    response = new Buffer(response, 'base64');
console.log("response", response.length);
	    this.socket.write(response);
	    this.state = STATE_AUTH_RES;
	}
	break;
    case STATE_AUTH_RES:
	if (this.recvBuf.length >= 4) {
	    var ok = this.recvBuf[3] === 0;
	    this.recvBuf = this.recvBuf.slice(4);
	    if (ok) {
		this.socket.write(new Buffer([1]));
		this.state = STATE_INIT;
	    } else {
		this.emit('error', new Error("Authentication failure"));
	    }
	}
	break;
    case STATE_INIT:
	if (this.recvBuf.length >= 24) {
	    var nameLen = this.recvBuf.readUInt32BE(20);
	    if (this.recvBuf.length >= 24 + nameLen) {
		this.width = this.recvBuf.readUInt16BE(0);
		this.height = this.recvBuf.readUInt16BE(0);
		this.name = this.recvBuf.slice(24, 24 + nameLen).toString();
		this.pixelFormat = parsePixelFormat(this.recvBuf.slice(4, 20));

		this.recvBuf = this.recvBuf.slice(24 + nameLen);
		this.state = STATE_MSG;
		this.emit('init', {
		    width: this.width,
		    height: this.height,
		    name: this.name,
		    pixelFormat: this.pixelFormat
		});
	    }
	}
	break;
    case STATE_MSG:
	if (this.recvBuf.length >= 1) {
	    switch(this.recvBuf[0]) {
	    case MSG_FRAMEBUFFER_UPDATE:
		if (this.recvBuf.length >= 4) {
		    this.rectangles = this.recvBuf.readUInt16BE(2);
		    this.recvBuf = this.recvBuf.slice(4);

		    this.state = STATE_RECTANGLES;
		    this.onData();
		}
		break;
	    default:
		this.emit('error', new Error("Unknown message type"));
	    }
	}
	break;
    case STATE_RECTANGLES:
	if (this.recvBuf.length >= 12) {
	    var x = this.recvBuf.readUInt16BE(0);
	    var y = this.recvBuf.readUInt16BE(2);
	    var w = this.recvBuf.readUInt16BE(4);
	    var h = this.recvBuf.readUInt16BE(6);
	    var encoding = this.recvBuf.readInt32BE(8);
	    var pixelsLen = Math.ceil(w * h * this.pixelFormat.bpp / 8);
	    if (this.recvBuf.length >= 12 + pixelsLen) {
		var pixels = this.recvBuf.slice(12, 12 + pixelsLen);
		this.recvBuf = this.recvBuf.slice(12 + pixelsLen);

		this.onRectangle(x, y, w, h, encoding, pixels);

		/* One frame received */
		this.rectangles--;
		if (this.rectangles < 1) {
		    this.state = STATE_MSG;
		    this.onData();
		}
	    }
	}
	break;
    default:
	console.log("Received in state", this.state, this.recvBuf);
    }
};

VNCClient.prototype.onRectangle = function(x, y, w, h, encoding, data) {
    if (encoding !== ENCODING_RAW) {
	this.emit('error', new Error("Received something else than RAW encoding"));
	return;
    }

    var x1, y1, offset = 0, pixels = [];
    for(y1 = y; y1 < y + h; y1++) {
	var line = [];
	for(x1 = x; x1 < x + w; x1++) {
	    var pixel;
	    switch(this.pixelFormat.bpp) {
	    case 8:
		pixel = data.readInt8(offset);
		offset++;
		break;
	    case 16:
		pixel = data.readUInt16BE(offset);
		offset += 2;
		break;
	    case 32:
		pixel = data.readUInt32BE(offset);
		offset += 4;
		break;
	    default:
		throw new Error("Unsupported bpp " + this.pixelFormat.bpp);
	    }

	    var rgb = [
		(pixel >> this.pixelFormat.rShift) & this.pixelFormat.rMax,
		(pixel >> this.pixelFormat.gShift) & this.pixelFormat.gMax,
		(pixel >> this.pixelFormat.bShift) & this.pixelFormat.bMax
	    ];
	    line.push(rgb);
	}
	pixels.push(line);
    }

    this.emit('rect', {
	x: x, y: y,
	w: w, h: h,
	pixels: pixels
    });
};

VNCClient.prototype.requestUpdate = function(x, y, w, h) {
    var b = new Buffer(10);
    b[0] = 3;
    b[1] = 0;
    b.writeUInt16BE(x, 2);
    b.writeUInt16BE(y, 4);
    b.writeUInt16BE(w, 6);
    b.writeUInt16BE(h, 8);
    this.socket.write(b);
};


/*var rfb = new VNCClient("localhost", 5900, "tim");
rfb.on('init', function(params) {
    console.log('init', params);

    console.log('requestUpdate', 0, 0, 80, 80);
    rfb.requestUpdate(0, 0, 100, 100);
    rfb.on('rect', function(rect) {
	//console.log("rect", rect);
	rect.pixels.forEach(function(line) {
	    var s = "";
	    line.forEach(function(rgb) {
		var s1 = rgb[2].toString(16);
		while(s1.length < 2)
		    s1 = "0" + s1;
		s += s1[1];
	    });
	    console.log(s);
	});
	rfb.requestUpdate(0, 0, 40, 40);
    });
});*/

/*setTimeout(function() {
    console.log("Hrm");
}, 5000);*/
