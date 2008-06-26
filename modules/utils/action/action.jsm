// Object-oriented action handler glue

Components.utils.import("resource://socialite/debug.jsm");

var EXPORTED_SYMBOLS = ["Action", "ActionType"];

function Action(name, func) {
  // Make a copy of the constructor function
  var action = function() { _MakeAction.apply(this, arguments); };

  // Make an action object, instantiatable with callbacks
  action.prototype = new ActionType();
  action.prototype.name = name;
  action.prototype.func = func;
  
  return action;
}

_MakeAction = function(successCallback, failureCallback) {
  this.successCallback = successCallback;
  this.failureCallback = failureCallback;
  this.performed = false;
  this.startTime = null;
}

function ActionType() {}

ActionType.prototype.perform = function() {
  debug_log("action", "Performing " + this.name + " action");

  if (!this.performed) {
    this.performed = true;
    this.startTime = Date.now();
    
    // Add this action object to the end of the arguments list and call.
    var newargs = Array.prototype.splice.call(arguments, 0) || [];
    newargs.push(this);
    return this.func.apply(null, newargs);
  } else {
    throw "Action has already been performed.";
  }
}

ActionType.prototype.doCallback = function(callback, args) {
  // Arguments contain the arguments passed to this function, with this action object at the end.
  var newargs = Array.prototype.splice.call(args, 0) || [];
  newargs.push(this);
  
  if (callback) {
    // A little sugar to allow actions to be passed in without calling toFunction()
    if (callback instanceof ActionType) {
      return callback.perform.apply(callback, newargs);
    } else {
      return callback.apply(null, newargs);
    }
  }
}

ActionType.prototype.success = function() {
  debug_log("action", this.name + " succeeded");
  return this.doCallback(this.successCallback, arguments);
}

ActionType.prototype.failure = function() {
  debug_log("action", this.name + " failed");
  return this.doCallback(this.failureCallback, arguments);
}

ActionType.prototype.toFunction = function() {
  var self = this;
  
  var doAction = function() {
    return self.perform.apply(self, arguments);
  }
  
  return doAction;
}